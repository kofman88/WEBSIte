'use strict';
/**
 * adminAlerts.js — port of admin_alerts.py (AUDIT-FIX-C91) for the alerts the auto-trade flow
 * raises: send_admin_alert (kv dedup `adm_alert_<key>` per alert type TTL), alert_sl_streak,
 * alert_auth_breaker.
 *
 * Delivery: `adminIds()` given → bot.sendMessage(aid, "🛎 <b>title</b>\n\ndetails", HTML) for each
 * (the bot's loop over Config.ADMIN_IDS); otherwise the site facade `bot.alertAdmins(text)`
 * (services/engine/signalDelivery — every active users.is_admin account).
 */

const { pf, F } = require('./pyfmt');
const { pyUpper } = require('../../strategies/common/pyUnicode');

const ALERT_DEDUP_TTL = Object.freeze({
  sl_streak: 6 * 3600,
  orphan_fail: 12 * 3600,
  auth_breaker: 3 * 3600,
  feedback_kw: 1 * 3600,
  zero_balance: 24 * 3600,
  anomaly_missing_sl: 30 * 60,
  ton_poll: 6 * 3600,
  ton_unmatched: 24 * 3600,
  anomaly_price_past_sl: 1 * 3600,
  turso_sync_fail: 6 * 3600,
  turso_auth_fatal: 24 * 3600,
  be_monitor_crash: 6 * 3600,
  plan_mass_change: 10 * 60,
});
const DEFAULT_TTL = 3600;

function createAdminAlerts({ now = () => Date.now() / 1000, kvGet = null, kvSet = null, adminIds = null, log = null } = {}) {
  const logger = log || require('../marketData/mdLog').log;

  async function shouldSend(dedupKey, ttl) {
    try {
      const last = await kvGet(`adm_alert_${dedupKey}`);
      if (last) {
        const v = Number(last);
        if (String(last).trim() !== '' && Number.isFinite(v) && now() - v < ttl) return false;
      }
      await kvSet(`adm_alert_${dedupKey}`, pf('%s', F(now())));
      return true;
    } catch (e) {
      logger.debug(`admin_alert dedup check: ${e && e.message}`);
      return true;
    }
  }

  async function sendAdminAlert(bot, title, details, dedupKey, alertType = '') {
    if (!bot) return;
    const ttl = Object.prototype.hasOwnProperty.call(ALERT_DEDUP_TTL, alertType) ? ALERT_DEDUP_TTL[alertType] : DEFAULT_TTL;
    if (!(await shouldSend(dedupKey, ttl))) {
      logger.debug(`admin_alert dedup: skip ${dedupKey}`);
      return;
    }
    const text = `🛎 <b>${title}</b>\n\n${details}`;
    if (adminIds) {
      const ids = await adminIds();
      if (!ids || !ids.length) return;
      for (const aid of ids) {
        try {
          await bot.sendMessage(aid, text, { parseMode: 'HTML' });
        } catch (e) {
          logger.debug(`admin_alert send to ${aid}: ${e && e.message}`);
        }
      }
      return;
    }
    if (typeof bot.alertAdmins === 'function') {
      try { await bot.alertAdmins(text); } catch (e) { logger.debug(`admin_alert send: ${e && e.message}`); }
    }
  }

  async function alertSlStreak(bot, userId, username, count, windowH = 24) {
    const uname = username ? `@${username}` : '—';
    await sendAdminAlert(bot,
      `SL-streak у юзера ${uname}`,
      `uid=<code>${userId}</code> (${uname})\n`
      + `Получил <b>${count} SL за ${windowH}ч</b>.\n`
      + 'Авто-трейд заблокирован C83 guard\'ом.\n\n'
      + `Диагностика: <code>/diag ${userId}</code>`,
      `sl_streak_${userId}`, 'sl_streak');
  }

  async function alertAuthBreaker(bot, userId, exchange, failures) {
    await sendAdminAlert(bot,
      'Auth breaker сработал',
      `uid=<code>${userId}</code>\n`
      + `Exchange: <b>${pyUpper(String(exchange))}</b>\n`
      + `Failures: <b>${failures}</b>\n`
      + 'API ключи могут быть протухшими / отозванными.\n\n'
      + `Проверь: /diag ${userId}`,
      `auth_breaker_${userId}_${exchange}`, 'auth_breaker');
  }

  return { sendAdminAlert, alertSlStreak, alertAuthBreaker, shouldSend };
}

module.exports = { ALERT_DEDUP_TTL, DEFAULT_TTL, createAdminAlerts };
