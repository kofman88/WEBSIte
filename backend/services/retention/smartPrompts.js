/**
 * smartPrompts — the bot's smart_prompts.py ([SMART-PROMPTS] event-triggered upgrade prompts),
 * one-to-one:
 *
 *   canSend / markSent / gcOld   the in-memory throttle: one prompt per (uid, kind) per 24 h;
 *                                past 1000 entries the ones older than 48 h are dropped
 *   isFreeActive(uid)            the user's sub_plan (or "free") lower-cased is "free"; an unknown
 *                                user or a failing read → False
 *   triggerAfterWin(bot, uid, symbol, r)   after a TP1 / TP2 / TP3 / TRAIL close with R > 0
 *                                (scanner_mid._check_breakevens reconcile — the M15 BE monitor
 *                                calls it there)
 *   triggerAfterQuotaHit(bot, uid)         a Free user's SMC preview quota is used up
 *                                (smc/scanner → services/engine/smcScanner deps.smartPromptQuota)
 *
 * `bot` is the delivery facade of the calling thread (signalDelivery.localFacade on the main
 * thread, createRemoteDelivery in the engine worker); a prompt is one notifier.dispatch of type
 * `promo` through its `notifier.dispatch` (botSend.js). The throttle lives in the memory of that
 * thread, as the bot's in its process. The texts are the bot's verbatim (decision D20).
 *
 * Log markers (CHM.SmartPrompts): [SMART-PROMPT-FIRE] uid=N kind=… (INFO), [SMART-PROMPT-SKIP]
 * … throttled / send (DEBUG).
 */

'use strict';

const botSend = require('./botSend');
const { pyInt } = require('../engine/pycoerce');
const { pyLower, pyUpper } = require('../../strategies/common/pyUnicode');
const { fmtFixed } = require('../../strategies/common/pyfmt');

const PROMPT_TTL_S = 86400.0;
const GC_THRESHOLD = 1000;
const PLAN_LINK = '/app/?tab=settings&sec=plan';

const PROMPT_LAST = new Map();       // `${uid}\u0000${kind}` → {uid, kind, ts}
const keyOf = (uid, kind) => `${uid}\u0000${kind}`;

// ── dependencies ─────────────────────────────────────────────────────────
function defaultDeps() {
  return {
    clock: () => Date.now() / 1000,
    planOf: (uid) => {
      const row = require('../../models/database')
        .prepare('SELECT user_id, sub_plan FROM trader_settings WHERE user_id = ?').get(uid);
      return row ? [row] : [];
    },
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
  PROMPT_LAST.clear();
}

const log = () => _deps.log || require('../../utils/logger');
const debug = (m) => { const l = log(); if (l.debug) l.debug(m); };

/** _gc_old(): past GC_THRESHOLD entries, drop the ones older than 2 × TTL. */
function gcOld() {
  if (PROMPT_LAST.size <= GC_THRESHOLD) return;
  const cutoff = _deps.clock() - PROMPT_TTL_S * 2;
  for (const [k, v] of [...PROMPT_LAST]) {
    if (v.ts < cutoff) PROMPT_LAST.delete(k);
  }
}

/** _can_send(uid, kind): no prompt of this kind to this user in the last 24 h. */
function canSend(userId, kind) {
  const e = PROMPT_LAST.get(keyOf(userId, kind));
  const last = e ? e.ts : 0.0;
  return (_deps.clock() - last) >= PROMPT_TTL_S;
}

/** _mark_sent(uid, kind) */
function markSent(userId, kind) {
  PROMPT_LAST.set(keyOf(userId, kind), { uid: userId, kind, ts: _deps.clock() });
  gcOld();
}

/** _is_free_active(uid): the first users row with this id decides; none / an error → False. */
async function isFreeActive(userId) {
  try {
    for (const u of await _deps.planOf(userId)) {
      if (pyInt(u.user_id === undefined ? 0 : u.user_id) === userId) {
        return pyLower(u.sub_plan || 'free') === 'free';
      }
    }
  } catch (e) {
    debug(`_is_free_active uid=${userId}: ${botSend.errText(e)}`);
  }
  return false;
}

const showPlans = (label) => [[{ id: 'show_plans', label, action: PLAN_LINK, kind: 'url', callback: 'show_plans' }]];

/** str.replace(old, new) replaces every occurrence. */
const replaceAll = (s, a, b) => s.split(a).join(b);

/** trigger_after_win(bot, uid, symbol, r_value) */
async function triggerAfterWin(bot, userId, symbol, rValue) {
  if (!canSend(userId, 'after_win')) {
    debug(`[SMART-PROMPT-SKIP] uid=${userId} kind=after_win throttled`);
    return;
  }
  if (!(await isFreeActive(userId))) return;
  const sym = String(symbol);
  const symShort = pyUpper(replaceAll(replaceAll(sym, '-USDT-SWAP', ''), '-USDT', '')) || sym;
  const r1 = fmtFixed(rValue, 1);
  const text = `🎉 <b>Поздравляем — твоя сделка ${symShort} закрылась с +${r1}R!</b>\n\n`
    + 'Free тариф = до 5 сигналов в день (2 LEVELS + 3 SMC preview).\n'
    + '⭐ <b>Pro</b> даёт <b>5-10× больше сигналов</b>:\n'
    + '  • SMC автотрейд (15-25 сделок/неделю, проверено на 10K+ trades)\n'
    + '  • Оптимизатор параметров под твою стратегию\n'
    + '  • AI-фильтр сигналов\n\n'
    + `Если ты заработал ${r1}R на free — представь сколько на Pro.\n`
    + '<i>Pro $69/мес окупается за 1-2 закрытые сделки.</i>';
  try {
    await botSend.send(botSend.facadeDispatch(bot), userId, {
      type: 'promo', text, link: PLAN_LINK, actions: showPlans('⭐ Подписаться на Pro'),
    });
    markSent(userId, 'after_win');
    log().info(`[SMART-PROMPT-FIRE] uid=${userId} kind=after_win sym=${sym} r=${r1}`);
  } catch (e) {
    debug(`[SMART-PROMPT-SKIP] uid=${userId} kind=after_win send: ${botSend.errText(e)}`);
  }
}

/** trigger_after_quota_hit(bot, uid) */
async function triggerAfterQuotaHit(bot, userId) {
  if (!canSend(userId, 'after_quota_hit')) return;
  if (!(await isFreeActive(userId))) return;
  const text = '⏳ <b>Лимит free тарифа достигнут.</b>\n\n'
    + 'Сегодня бот нашёл больше setups, но free = 3 сигнала/день максимум.\n\n'
    + '⭐ <b>Pro = безлимит:</b>\n'
    + '  • 15-25 SMC сигналов/неделю\n'
    + '  • 50+ LEVELS setups/неделю\n'
    + '  • Авто-трейд через биржу (Bybit/Binance/OKX)\n\n'
    + '<i>$69/мес окупается за 1-2 сделки с +1.5R.</i>';
  try {
    await botSend.send(botSend.facadeDispatch(bot), userId, {
      type: 'promo', text, link: PLAN_LINK, actions: showPlans('⭐ Активировать Pro'),
    });
    markSent(userId, 'after_quota_hit');
    log().info(`[SMART-PROMPT-FIRE] uid=${userId} kind=after_quota_hit`);
  } catch (e) {
    debug(`[SMART-PROMPT-SKIP] uid=${userId} kind=after_quota_hit send: ${botSend.errText(e)}`);
  }
}

/** The throttle entries as [uid, kind, ts] (tests, admin). */
function throttleEntries() {
  return [...PROMPT_LAST.values()].map((v) => [v.uid, v.kind, v.ts]);
}

module.exports = {
  PROMPT_TTL_S, GC_THRESHOLD, PLAN_LINK, canSend, markSent, gcOld, isFreeActive, triggerAfterWin,
  triggerAfterQuotaHit, throttleEntries, configure, resetDeps,
};
