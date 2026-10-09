'use strict';
/**
 * skipNotify.js — the two "why was my signal skipped" notifiers of the bot:
 *
 *   notifySkipToUser(bot, uid, symbol, gate, lang, kwargs)   auto_trade._notify_skip_to_user
 *       per-(uid, sym_clean, gate) 1 h dedup, i18n key by gate (skip_notify_generic + {gate}
 *       otherwise), send failure → enqueueCritical(reason=skip_notify_<gate>). Best effort.
 *   recordUnfilled(bot, uid, symbol)                         skip_notify.record_unfilled
 *       sliding 1 h window of LIMIT-unfilled events; at SKIP_NOTIFY_THRESHOLD (5) one escalation
 *       message per 4 h; `[SKIP-NOTIFY] uid=… count=… escalated=…`.
 */

const { t } = require('./messages');
const { pf } = require('./pyfmt');
const { htmlEscape } = require('../exchanges/pyCompat');

const SKIP_NOTIFY_KEYS = Object.freeze({
  counter_trend: 'skip_notify_counter_trend',
  counter_trend_scanner: 'skip_notify_counter_trend',
  smc_max_sl_pct: 'skip_notify_max_sl',
  max_sl_pct: 'skip_notify_max_sl',
  ml_signal_filter: 'skip_notify_ml_filter',
  hour_of_day: 'skip_notify_hour_filter',
  sl_streak_guard: 'skip_notify_sl_streak',
  funding_rate_gate: 'skip_notify_funding',
  low_notional_skip: 'skip_notify_low_balance',
  disabled_days: 'skip_notify_disabled_day',
});
const SKIP_WINDOW_S = 3600;
const ESCALATION_THROTTLE_S = 4 * 3600;

function createSkipNotify({
  now = () => Date.now() / 1000, log = null, sendMessage = null, enqueueCritical = null, env = process.env,
} = {}) {
  const logger = log || require('../marketData/mdLog').log;
  const dedup = new Map();
  const userUnfilled = new Map();   // uid → [ts]
  const lastNotified = new Map();   // uid → ts
  const threshold = Math.trunc(Number(env.SKIP_NOTIFY_THRESHOLD || '5'));

  async function notifySkipToUser(bot, userId, symbol, gate, lang = 'ru', kwargs = {}) {
    if (!bot || !userId || !symbol) return;
    try {
      const symClean = String(symbol).split('-USDT-SWAP').join('').split('-USDT').join('');
      const key = `${Math.trunc(userId)}|${symClean}|${gate}`;
      const nowTs = now();
      const last = dedup.has(key) ? dedup.get(key) : 0.0;
      if (nowTs - last < 3600.0) return;
      dedup.set(key, nowTs);
      const i18nKey = SKIP_NOTIFY_KEYS[gate] || 'skip_notify_generic';
      const tk = { ...kwargs };
      if (i18nKey === 'skip_notify_generic' && !Object.prototype.hasOwnProperty.call(tk, 'gate')) tk.gate = gate;
      tk.symbol = symClean;
      const msg = t(i18nKey, lang, tk);
      const ok = await sendMessage(bot, userId, msg, { parseMode: 'HTML' });
      if (!ok) {
        try {
          if (enqueueCritical) await enqueueCritical(bot, userId, msg, { parseMode: 'HTML', reason: `skip_notify_${gate}` });
        } catch (qe) {
          logger.debug(pf('skip-notify queue uid=%s gate=%s: %s', userId, gate, qe && qe.message));
        }
      }
    } catch (e) {
      logger.debug(pf('skip-notify exc uid=%s sym=%s gate=%s: %s', userId, symbol, gate, e && e.message));
    }
  }

  function prune(uid, nowTs) {
    const dq = userUnfilled.get(uid);
    if (!dq) return;
    const cutoff = nowTs - SKIP_WINDOW_S;
    while (dq.length && dq[0] < cutoff) dq.shift();
  }

  async function recordUnfilled(bot, userId, symbol) {
    if (!userId || userId <= 0) return;
    try {
      const nowTs = now();
      if (!userUnfilled.has(userId)) userUnfilled.set(userId, []);
      const dq = userUnfilled.get(userId);
      dq.push(nowTs);
      prune(userId, nowTs);
      const count = dq.length;
      if (count < threshold) {
        logger.debug(pf('[SKIP-NOTIFY] uid=%s count=%d below threshold=%d', userId, count, threshold));
        return;
      }
      const lastTs = lastNotified.has(userId) ? lastNotified.get(userId) : 0.0;
      if (nowTs - lastTs < ESCALATION_THROTTLE_S) {
        logger.debug(pf('[SKIP-NOTIFY] uid=%s count=%d throttled (last %ds ago)', userId, count, Math.trunc(nowTs - lastTs)));
        return;
      }
      lastNotified.set(userId, nowTs);
      if (!bot) {
        logger.info(pf('[SKIP-NOTIFY] uid=%s count=%d escalated=False (no bot)', userId, count));
        return;
      }
      const symSafe = htmlEscape(symbol || '');
      const text = '⚠️ <b>Много неисполнившихся ордеров</b>\n'
        + '\n'
        + `За последний час твоих лимитных входов <b>${count}</b> `
        + `не исполнилось (последний — ${symSafe}).\n`
        + '\n'
        + 'Это бывает в трендовом рынке: цена уходит до того, '
        + 'как лимит подтянется.\n'
        + '\n'
        + '<b>Что можно сделать:</b>\n'
        + '• Подключить вход <b>по рынку</b> в /settings → 🛡 Risk Management\n'
        + '• Или подождать боковика — лимиты исполняются лучше';
      try {
        await sendMessage(bot, userId, text, { parseMode: 'HTML' });
      } catch (se) {
        logger.debug(pf('[SKIP-NOTIFY] send uid=%s: %s', userId, se && se.message));
        return;
      }
      logger.info(pf('[SKIP-NOTIFY] uid=%s count=%d escalated=True sym=%s', userId, count, symbol));
    } catch (e) {
      logger.debug(pf('[SKIP-NOTIFY] record_unfilled uid=%s: %s', userId, e && e.message));
    }
  }

  function getUnfilledCount(userId) {
    prune(userId, now());
    return (userUnfilled.get(userId) || []).length;
  }

  /**
   * cache_gc's skip_notify block: prune every window, drop users with an empty window and no
   * escalation for 24 h, drop escalation stamps older than 7 days → {userUnfilled, lastNotified}.
   */
  function gcState() {
    const nowTs = now();
    const cutoff = nowTs - SKIP_WINDOW_S;
    const staleU = [];
    for (const [uid, dq] of Array.from(userUnfilled.entries())) {
      while (dq.length && dq[0] < cutoff) dq.shift();
      const lastTs = lastNotified.has(uid) ? lastNotified.get(uid) : 0.0;
      if (!dq.length && (nowTs - lastTs) > 24 * 3600) staleU.push(uid);
    }
    for (const uid of staleU) userUnfilled.delete(uid);
    const cut7 = nowTs - 7 * 24 * 3600;
    const staleN = Array.from(lastNotified.entries()).filter(([, ts]) => typeof ts === 'number' && ts < cut7).map(([u]) => u);
    for (const u of staleN) lastNotified.delete(u);
    return { userUnfilled: staleU.length, lastNotified: staleN.length };
  }

  return {
    notifySkipToUser, recordUnfilled, getUnfilledCount, gcState, _dedup: dedup, _userUnfilled: userUnfilled, _lastNotified: lastNotified,
  };
}

module.exports = { SKIP_NOTIFY_KEYS, createSkipNotify };
