/**
 * engagement — the bot's engagement.py (AUDIT-FIX-C64 re-engagement reminders) and the opt-out
 * button of handlers/subscription.py (cb_engagement_optout), one-to-one:
 *
 *   whichReminder(user, now)   _which_reminder: "3d" | "1d" | "7d_after" | "14d_after" |
 *                              "30d_after" | null (opt-out, 24 h anti-spam, no expiry, flags)
 *   render / keyboard          _render (i18n texts, RU fallback) / _kb_renew (pay link + opt-out)
 *   sendReminder(user, type)   _send_reminder: send → flag + last_reminder_at + save; Forbidden /
 *                              BadRequest → active = False (the bot stops trying); other → False
 *   runPass / startLoop        engagement_loop: 120 s after start, then hourly over all users
 *                              (active only), 0.3 s between sends
 *   handleOptoutCallback(uid)  handle_optout_callback: reminders_optout = True
 *   optoutButton(caller, data) cb_engagement_optout: the uid in the button's data must be the
 *                              caller's ("⚠️ Этот выбор не для вас" otherwise)
 *
 * Site mapping: a send is one notifier.dispatch of type `reminder` (botSend.js); the Telegram
 * errors are the site's (deleted / deactivated account = Forbidden, a notification that was not
 * stored = BadRequest), so a reminder that only failed in the Telegram mirror still counts as
 * sent. The keyboard is the bot's two buttons as action rows: the pay link (the bot's URL) and
 * the opt-out button, routed to POST /api/app/engagement/optout. The user rows are
 * traderSettingsService users (um.all_users = allUsers, 30 s cache; um.save = save).
 *
 * The subscription_reminder_task port (planService.runExpiryLoop) sets the same
 * reminder_3d_sent / reminder_1d_sent flags, so a user gets the 3d / 1d message from whichever
 * loop runs first — the bot's race, kept.
 *
 * Log markers (CHM.Engagement): Engagement loop started (interval=3600s), [ENG-SENT],
 * [ENG-BLOCK], [ENG-BAD], [ENG-ERR], [ENG-SAVE], [ENG-OPTOUT], Engagement: checked N users,
 * sent M reminders, engagement_loop iteration: ….
 */

'use strict';

const botSend = require('./botSend');
const { pyInt } = require('../engine/pycoerce');

const DAY = 86400;
const LOOP_INTERVAL_S = 3600;
const MIN_GAP_BETWEEN_REMINDERS = 24 * 3600;
const SEND_THROTTLE_S = 0.3;
const START_DELAY_S = 120;
const PAY_URL = 'https://t.me/crypto_chm';
const PLAN_LINK = '/app/?tab=settings&sec=plan';
const OPTOUT_ACTION = 'engagement_optout';
const OPTOUT_API = Object.freeze({ method: 'POST', path: 'engagement/optout' });

// i18n.py, verbatim
const T = Object.freeze({
  engagement_reminder_3d: {
    ru: '⏰ <b>Через 3 дня закончится твой доступ</b>\n\nТы пользуешься CHM BREAKER уже несколько недель. Чтобы не потерять сигналы и автотрейд — оформи подписку.\n\n📦 <b>3 месяца</b> — выгоднее на 30%\n📦 <b>12 месяцев</b> — лучшая цена\n\n🆔 <code>{user_id}</code>',
    en: "⏰ <b>Your access expires in 3 days</b>\n\nYou've been using CHM BREAKER for weeks. Renew now to keep signals and auto-trade running.\n\n📦 <b>3 months</b> — 30% better\n📦 <b>12 months</b> — best price\n\n🆔 <code>{user_id}</code>",
  },
  engagement_reminder_1d: {
    ru: '🚨 <b>Завтра подписка истекает</b>\n\nПосле окончания подписки бот перестанет:\n• присылать сигналы\n• открывать сделки автоматически\n• следить за SL/TP в открытых позициях\n\nПродли сейчас и не теряй доступ.\n\n🆔 <code>{user_id}</code>',
    en: '🚨 <b>Subscription expires tomorrow</b>\n\nOnce it expires the bot will stop:\n• sending signals\n• auto-opening trades\n• watching SL/TP on open positions\n\nRenew now to keep your access.\n\n🆔 <code>{user_id}</code>',
  },
  engagement_reminder_7d_after: {
    ru: '👋 <b>Прошла неделя без CHM BREAKER</b>\n\nЗа эту неделю наша система отработала десятки сигналов. Ты пропустил их — но всегда можешь вернуться.\n\nБез подписки бот не отправит ни сигнала и не откроет позицию. Твой ID и настройки сохранены — оплата → доступ восстановлен мгновенно.\n\n🆔 <code>{user_id}</code>',
    en: "👋 <b>It's been a week without CHM BREAKER</b>\n\nOur system processed dozens of signals this week. You missed them — but you can always come back.\n\nWithout a subscription the bot won't send signals or open positions. Your ID and settings are saved — pay → instant access.\n\n🆔 <code>{user_id}</code>",
  },
  engagement_reminder_14d_after: {
    ru: '📊 <b>Уже 2 недели без сигналов</b>\n\nРынок не ждёт. Пока ты отсутствуешь — бот наших платных юзеров продолжает фиксировать прибыль (см. <a href="https://t.me/crypto_chm">канал</a>).\n\nЕсли устраивает то что есть — это нормально, отпишись от напоминаний кнопкой ниже. Если хочется вернуться — администратор поможет.\n\n🆔 <code>{user_id}</code>',
    en: "📊 <b>2 weeks without signals</b>\n\nMarket doesn't wait. While you're away — the bot for our paid users keeps locking in profits (see <a href=\"https://t.me/crypto_chm\">channel</a>).\n\nIf you're fine without it — it's OK, opt out via the button below. If you want to come back — admin will help.\n\n🆔 <code>{user_id}</code>",
  },
  engagement_reminder_30d_after: {
    ru: '⏳ <b>Месяц прошёл</b>\n\nЭто последнее напоминание — больше беспокоить не будем.\n\nЕсли CHM BREAKER не подошёл — это нормально, спасибо что пробовал. Если хочешь дать второй шанс — напиши админу, начнём с чистого листа.\n\n🆔 <code>{user_id}</code>',
    en: "⏳ <b>One month passed</b>\n\nThis is the last reminder — we won't bother you any more.\n\nIf CHM BREAKER didn't fit — that's fine, thanks for trying. If you'd like a second chance — message admin and we'll start fresh.\n\n🆔 <code>{user_id}</code>",
  },
  engagement_btn_pay: { ru: '✍️ Оплатить — Написать админу', en: '✍️ Pay — Contact admin' },
  engagement_btn_optout: { ru: '🔕 Не присылать напоминания', en: '🔕 Stop sending reminders' },
  engagement_optout_ack: {
    ru: '🔕 Напоминания отключены. Если передумаешь — напиши админу.',
    en: '🔕 Reminders disabled. Change your mind? Message admin.',
  },
  engagement_optout_failed: { ru: '❌ Не удалось обновить настройки', en: '❌ Failed to update settings' },
  engagement_optout_wrong_user: { ru: '⚠️ Этот выбор не для вас', en: "⚠️ This action isn't for you" },
});

const REMINDER_KEYS = Object.freeze({
  '3d': 'engagement_reminder_3d',
  '1d': 'engagement_reminder_1d',
  '7d_after': 'engagement_reminder_7d_after',
  '14d_after': 'engagement_reminder_14d_after',
  '30d_after': 'engagement_reminder_30d_after',
});

const FLAGS = Object.freeze({
  '3d': 'reminder_3d_sent',
  '1d': 'reminder_1d_sent',
  '7d_after': 'reminder_7d_after_sent',
  '14d_after': 'reminder_14d_after_sent',
  '30d_after': 'reminder_30d_after_sent',
});

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** i18n.t(key, lang): MESSAGES[key][lang] or MESSAGES[key]["ru"]; `{user_id}` filled when given. */
function t(key, lang, userId = undefined) {
  const entry = T[key];
  const text = (typeof lang === 'string' && has(entry, lang) && entry[lang]) || entry.ru;
  return userId === undefined ? text : text.split('{user_id}').join(String(userId));
}

/** _user_lang: user.lang or "ru". */
function userLang(user) {
  return (user && user.lang) || 'ru';
}

/** _which_reminder(user, now) */
function whichReminder(user, now) {
  if (user.reminders_optout) return null;
  const last = Number(user.last_reminder_at || 0);
  if (last && (now - last) < MIN_GAP_BETWEEN_REMINDERS) return null;
  const status = user.sub_status === undefined || user.sub_status === null ? '' : user.sub_status;
  const expires = Number(user.sub_expires || 0);
  if (!expires) return null;
  if (status === 'trial' || status === 'active') {
    const left = expires - now;
    if (left <= 0) return null;
    if (left <= 1 * DAY && !user.reminder_1d_sent) return '1d';
    if (left <= 3 * DAY && !user.reminder_3d_sent) return '3d';
  }
  if (status === 'expired') {
    const daysAfter = (now - expires) / DAY;
    if (daysAfter >= 30 && !user.reminder_30d_after_sent) return '30d_after';
    if (daysAfter >= 14 && daysAfter < 30 && !user.reminder_14d_after_sent) return '14d_after';
    if (daysAfter >= 7 && daysAfter < 14 && !user.reminder_7d_after_sent) return '7d_after';
  }
  return null;
}

/** _render(type, user) */
function render(type, user) {
  return t(REMINDER_KEYS[type], userLang(user), user.user_id);
}

/** _flag_for(type) */
function flagFor(type) {
  if (!has(FLAGS, type)) throw new Error(`KeyError: '${type}'`);
  return FLAGS[type];
}

/** _kb_renew(uid, with_optout, lang) as action rows. */
function keyboard(uid, { withOptout = true, lang = 'ru' } = {}) {
  const rows = [[{ id: 'engagement_pay', label: t('engagement_btn_pay', lang), action: PAY_URL, kind: 'url' }]];
  if (withOptout) {
    rows.push([{
      id: 'engagement_optout', label: t('engagement_btn_optout', lang), action: `${OPTOUT_ACTION}:${uid}`, kind: 'callback',
      api: { ...OPTOUT_API },
    }]);
  }
  return rows;
}

// ── dependencies ─────────────────────────────────────────────────────────
function defaultDeps() {
  return {
    clock: () => Date.now() / 1000,
    dispatch: botSend.notifierDispatch(),
    allUsers: () => require('../traderSettingsService').allUsers(),
    getUser: (uid) => require('../traderSettingsService').get(uid),
    saveUser: (user) => require('../traderSettingsService').save(user),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    log: null,
  };
}

let _deps = defaultDeps();

function configure(over = {}) {
  _deps = { ..._deps, ...over };
  return _deps;
}

function resetDeps() {
  _deps = defaultDeps();
}

const log = () => _deps.log || require('../../utils/logger');
const warn = (m) => { const l = log(); (l.warning || l.warn).call(l, m); };
const debug = (m) => { const l = log(); if (l.debug) l.debug(m); };

/** _send_reminder(bot, user, type, um) → Promise<bool> */
async function sendReminder(user, type) {
  const uid = user.user_id;
  const lang = userLang(user);
  const text = render(type, user);
  const kb = keyboard(uid, { withOptout: true, lang });
  try {
    await botSend.send(_deps.dispatch, uid, { type: 'reminder', text, link: PLAN_LINK, actions: kb });
  } catch (e) {
    if (e && e.name === 'TelegramForbiddenError') {
      log().info(`[ENG-BLOCK] uid=${uid} blocked bot — deactivating`);
      try {
        user.active = false;
        await _deps.saveUser(user);
      } catch (_e) {
        debug('engagement._send_reminder() unhandled exception');
      }
      return false;
    }
    if (e && e.name === 'TelegramBadRequest') {
      log().info(`[ENG-BAD] uid=${uid} send failed: ${botSend.errText(e)} — deactivating`);
      try {
        user.active = false;
        await _deps.saveUser(user);
      } catch (_e) {
        debug('engagement._send_reminder() unhandled exception');
      }
      return false;
    }
    warn(`[ENG-ERR] uid=${uid} send failed: ${botSend.errText(e)}`);
    return false;
  }
  try {
    user[flagFor(type)] = true;
    user.last_reminder_at = _deps.clock();
    await _deps.saveUser(user);
    log().info(`[ENG-SENT] uid=${uid} type=${type} status=${user.sub_status === undefined ? '' : user.sub_status}`);
  } catch (e) {
    warn(`[ENG-SAVE] uid=${uid} save failed: ${botSend.errText(e)}`);
  }
  return true;
}

/** One iteration of engagement_loop (the body of its `while True` try). */
async function runPass({ stopped = () => false } = {}) {
  try {
    const users = await _deps.allUsers();
    const now = _deps.clock();
    let sent = 0;
    let checked = 0;
    for (const user of users) {
      if (stopped()) return { checked, sent, cancelled: true };
      checked += 1;
      if (!user.active) continue;
      const rt = whichReminder(user, now);
      if (!rt) continue;
      if (await sendReminder(user, rt)) sent += 1;
      await _deps.sleep(SEND_THROTTLE_S * 1000);
    }
    if (sent > 0) log().info(`Engagement: checked ${checked} users, sent ${sent} reminders`);
    return { checked, sent };
  } catch (e) {
    warn(`engagement_loop iteration: ${botSend.errText(e)}`);
    return { error: botSend.errText(e) };
  }
}

/** engagement_loop: the start line, 120 s, then a pass every LOOP_INTERVAL_S. Returns stop(). */
function startLoop({ initialDelayS = START_DELAY_S, intervalS = LOOP_INTERVAL_S } = {}) {
  log().info(`Engagement loop started (interval=${LOOP_INTERVAL_S}s)`);
  let timer = null;
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    await runPass({ stopped: () => stopped });
    if (!stopped) timer = setTimeout(run, intervalS * 1000);
  };
  timer = setTimeout(run, initialDelayS * 1000);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

/** handle_optout_callback(user_id, um) → Promise<bool> */
async function handleOptoutCallback(userId) {
  try {
    const user = await _deps.getUser(userId);
    if (!user) return false;
    user.reminders_optout = true;
    await _deps.saveUser(user);
    log().info(`[ENG-OPTOUT] uid=${userId} opted out`);
    return true;
  } catch (e) {
    warn(`handle_optout_callback uid=${userId}: ${botSend.errText(e)}`);
    return false;
  }
}

/**
 * cb_engagement_optout: `data` is the button's callback data (`engagement_optout:<uid>`), the
 * caller the signed-in user. The uid is int() of the part after the first ':' (anything that
 * does not parse → the caller's own id, as the bot); the answer's language is the caller's.
 * → {ok, show_alert: true, message[, error]} (cb.answer(text, show_alert=True)).
 */
async function optoutButton(callerId, data) {
  let uid;
  try {
    const s = typeof data === 'string' ? data : '';
    const i = s.indexOf(':');
    if (i < 0) throw new RangeError('IndexError: list index out of range');
    uid = pyInt(s.slice(i + 1));
  } catch (_e) {
    uid = callerId;
  }
  let lang = 'ru';
  try {
    const user = await _deps.getUser(callerId);
    if (user) lang = user.lang || 'ru';
  } catch (_e) {
    debug('subscription.cb_engagement_optout() unhandled exception');
  }
  if (String(callerId) !== String(uid)) {
    return { ok: false, error: 'wrong_user', show_alert: true, message: t('engagement_optout_wrong_user', lang) };
  }
  const ok = await handleOptoutCallback(callerId);
  if (ok) return { ok: true, show_alert: true, message: t('engagement_optout_ack', lang) };
  return { ok: false, error: 'failed', show_alert: true, message: t('engagement_optout_failed', lang) };
}

module.exports = {
  DAY, LOOP_INTERVAL_S, MIN_GAP_BETWEEN_REMINDERS, SEND_THROTTLE_S, START_DELAY_S, PAY_URL, PLAN_LINK,
  OPTOUT_ACTION, REMINDER_KEYS, FLAGS, T,
  t, userLang, whichReminder, render, flagFor, keyboard, sendReminder, runPass, startLoop,
  handleOptoutCallback, optoutButton, configure, resetDeps,
};
