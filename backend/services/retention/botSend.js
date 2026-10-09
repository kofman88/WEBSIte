/**
 * botSend — `await bot.send_message(uid, text, parse_mode="HTML", reply_markup=kb, …)` of the
 * bot's retention modules (engagement.py, drip_campaign.py, smart_prompts.py) on the site:
 * one notifier.dispatch (in-app row + SSE, Telegram mirror, e-mail by preference), which
 * either resolves like the sent Message or throws the aiogram error those modules branch on —
 * the same mapping as signalDelivery.sendMessage:
 *
 *   {dispatched: true}            → resolves {message_id: <notification id>}
 *   {error: 'user_not_found'}     → TelegramForbiddenError (deleted / deactivated account =
 *                                   the user blocked the bot)
 *   {error: …} / no answer        → TelegramBadRequest "notification not stored"
 *   dispatch throws               → that error unchanged (the modules' generic `except Exception`)
 *
 * `dispatch` is any `(uid, opts) → Promise<result>`: services/notifier on the main thread, the
 * delivery facade's `notifier.dispatch` RPC in the engine worker.
 */

'use strict';

const { TG_ERRORS, telegramError } = require('../engine/signalDelivery');

/** The first line of the bot's HTML text without tags and entities (the in-app title). */
function titleOf(text) {
  return String(text).split('\n')[0].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').slice(0, 200);
}

/**
 * send(dispatch, uid, {type, text, link, actions, silent}) → Promise<{message_id}>, or throws
 * the named error. `actions` are keyboard rows ({id, label, action, kind[, api]}).
 */
async function send(dispatch, uid, { type, text, link = null, actions = null, silent = false }) {
  const body = String(text || '');
  if (!body) throw telegramError(TG_ERRORS.empty);
  const res = await dispatch(uid, {
    type, title: titleOf(body), body, tgText: body, link, silent: Boolean(silent),
    data: { text: body, actions },
  });
  if (res && res.dispatched) return { message_id: res.notificationId === undefined ? null : res.notificationId };
  throw telegramError(res && res.error === 'user_not_found' ? TG_ERRORS.forbidden : TG_ERRORS.failed);
}

/** The default dispatch of the main thread. */
function notifierDispatch() {
  return (uid, opts) => require('../notifier').dispatch(uid, opts);
}

/** The dispatch of a delivery facade (signalDelivery.localFacade / createRemoteDelivery). */
function facadeDispatch(bot) {
  return (uid, opts) => bot.notifier.dispatch(uid, opts);
}

/** str(e) of the error a send raised: aiogram's "Telegram server says - …", else the message. */
function errText(e) {
  return e && e.message !== undefined ? String(e.message) : String(e);
}

module.exports = { send, titleOf, notifierDispatch, facadeDispatch, errText };
