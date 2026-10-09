'use strict';
/**
 * tiltDetector.js — port of tilt_detector.py ([W3.1 TILT-DETECTOR]): an educational nudge after
 * a trade opens (never a block).
 *
 *   detectAndNotify(bot, uid) → {pattern, notified}
 *     patterns in order 3sl_in_1h (≥3 SL created in the last hour) / revenge_trade (the newest
 *     two rows: previous SL, gap 0 < Δcreated_at < 300 s) / early_close (≥3 MANUAL with
 *     0 < rr < 0.3 in the last 30 min); first match wins; 1 h dedup per (uid, pattern);
 *     `[TILT-DETECT] uid=… pattern=… notified=…`.
 */

const { pf } = require('./pyfmt');

const NOTIFY_TTL = 3600.0;

function formatMessage(pattern) {
  if (pattern === '3sl_in_1h') {
    return '⚠️ <b>Внимание — поведенческий паттерн</b>\n\n'
      + 'За последний час у тебя <b>3+ стоп-лосса подряд</b>. Это часто '
      + 'сигнал о смене условий рынка либо психологического tilt.\n\n'
      + '<b>Что советует bot:</b>\n'
      + '• Сделай паузу 30-60 минут\n'
      + '• Не увеличивай risk_pct «отыграться»\n'
      + '• Перепроверь рыночный режим (/menu → 📊 Мои результаты)\n\n'
      + '<i>Это не блок — твой trading продолжается. Просто инфо.</i>\n\n'
      + 'Отключить: /settings → 🛡 Risk Management → Tilt detector';
  }
  if (pattern === 'revenge_trade') {
    return '⚠️ <b>Возможный revenge-trade</b>\n\n'
      + 'Ты открыл новую сделку <b>через &lt;5 минут</b> после стоп-'
      + 'лосса. Это классический паттерн «отыгрыша» — 80% таких '
      + 'сделок убыточные.\n\n'
      + '<b>Что советует bot:</b>\n'
      + '• Дай рынку остыть 15-30 минут\n'
      + '• Проверь RR — он реально 1.5+ или ты «впрыгнул»?\n'
      + '• Не повышай leverage чтобы «отыграть» меньшим SL\n\n'
      + '<i>Сделка открыта, никто не блокирует.</i>';
  }
  if (pattern === 'early_close') {
    return '📉 <b>Ты закрываешь прибыли слишком рано</b>\n\n'
      + 'За последние 30 минут ты <b>3+ раза закрыл сделку вручную</b> '
      + 'с прибылью &lt;0.3R. Это съедает edge стратегии — нужен RR ≥1.5 '
      + 'чтобы система работала.\n\n'
      + '<b>Что советует bot:</b>\n'
      + '• Доверяй TP1 (он уже рассчитан с RR 1.5+)\n'
      + '• Включи Hold-lock в /settings — заблокирует ранний manual close\n'
      + '• Посмотри статистику /menu → 📊 Мои результаты';
  }
  return `⚠️ Поведенческий паттерн обнаружен: ${pattern}`;
}

function createTiltDetector({ db = null, now = () => Date.now() / 1000, log = null, sendMessage = null } = {}) {
  const dbOf = () => (db ? db : require('../../models/database'));
  const logger = log || require('../marketData/mdLog').log;
  const dedup = new Map();

  async function check3slIn1h(uid) {
    try {
      const row = dbOf().prepare("SELECT COUNT(*) AS n FROM signal_trades WHERE user_id=? AND result='SL' AND created_at >= ?").get(Number(uid), now() - 3600);
      return (row ? row.n : 0) >= 3;
    } catch (_e) {
      return false;
    }
  }

  async function checkRevengeTrade(uid) {
    try {
      const rows = dbOf().prepare('SELECT result, created_at FROM signal_trades WHERE user_id=? ORDER BY created_at DESC LIMIT 2').all(Number(uid));
      if (rows.length < 2) return false;
      const prev = rows[1];
      if (prev.result !== 'SL') return false;
      const gap = Number(rows[0].created_at) - Number(prev.created_at);
      return gap > 0 && gap < 300;
    } catch (_e) {
      return false;
    }
  }

  async function checkEarlyCloseStreak(uid) {
    try {
      const row = dbOf().prepare("SELECT COUNT(*) AS n FROM signal_trades WHERE user_id=? AND result='MANUAL' AND result_rr < 0.3 AND result_rr > 0 AND created_at >= ?")
        .get(Number(uid), now() - 30 * 60);
      return (row ? row.n : 0) >= 3;
    } catch (_e) {
      return false;
    }
  }

  async function detectAndNotify(bot, uid) {
    const patterns = [];
    if (await check3slIn1h(uid)) patterns.push('3sl_in_1h');
    if (await checkRevengeTrade(uid)) patterns.push('revenge_trade');
    if (await checkEarlyCloseStreak(uid)) patterns.push('early_close');
    if (!patterns.length) return { pattern: null, notified: false };
    const pattern = patterns[0];
    const nowTs = now();
    const key = `${uid}|${pattern}`;
    const last = dedup.get(key) || 0;
    if (nowTs - last < NOTIFY_TTL) {
      logger.debug(pf('[TILT-DETECT] uid=%s pattern=%s dedup', uid, pattern));
      return { pattern, notified: false };
    }
    dedup.set(key, nowTs);
    if (!bot) {
      logger.info(pf('[TILT-DETECT] uid=%s pattern=%s notified=False (no bot)', uid, pattern));
      return { pattern, notified: false };
    }
    try {
      await sendMessage(bot, uid, formatMessage(pattern), { parseMode: 'HTML' });
    } catch (e) {
      logger.debug(`tilt notify uid=${uid}: ${e && e.message}`);
      return { pattern, notified: false };
    }
    logger.info(pf('[TILT-DETECT] uid=%s pattern=%s notified=True', uid, pattern));
    return { pattern, notified: true };
  }

  function gcDedup() {
    const t = now();
    const stale = Array.from(dedup.entries()).filter(([, ts]) => t - ts > NOTIFY_TTL * 2).map(([k]) => k);
    for (const k of stale) dedup.delete(k);
    return stale.length;
  }

  return { detectAndNotify, gcDedup, formatMessage, _dedup: dedup };
}

module.exports = { NOTIFY_TTL, formatMessage, createTiltDetector };
