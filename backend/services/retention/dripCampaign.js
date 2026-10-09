/**
 * dripCampaign — the bot's drip_campaign.py ([DRIP-CAMPAIGN] 7-day free→paid drip), one-to-one:
 *
 *   buildMessage(day)       _build_message: the day 1 / 3 / 5 / 7 texts (RU only, as the bot) and
 *                           their button; any other day → ("", [])
 *   processUser(row)        _process_user: free plan, created_at > 0, age ≤ 8 days, day =
 *                           int(age) + 1 ∈ {1, 3, 5, 7}, not yet sent (kv drip_sent_day{N}_{uid};
 *                           a kv read error counts as sent) → silent send, then the kv mark
 *   runPass / startLoop     drip_loop: sleep an hour, pass over db_get_all_users (1 s pause every
 *                           25 users), "cycle done"; an error → WARNING + one more hour
 *
 * Site mapping: rows are `trader_settings` (user_id, sub_plan, created_at — the first visit of
 * the app, as the bot's /start) in db_get_all_users order (created_at DESC); a send is a silent
 * notifier.dispatch of type `promo` (disable_notification=True), the bot's buttons become
 * links: dashboard_show → the stats tab, show_plans → the plan screen. kv = engine_kv. The texts
 * are the bot's verbatim (day 5 still names TON, which the site does not take — decision D20).
 *
 * Log markers (CHM.DripCampaign): [DRIP] loop started, interval=3600s, [DRIP-FIRE] uid=N day=K
 * age=X.Xd, [DRIP-SKIP] … send_fail (DEBUG), [DRIP] cycle done — processed=N,
 * drip_loop iteration: ….
 */

'use strict';

const botSend = require('./botSend');
const { pyInt, pyFloat } = require('../engine/pycoerce');
const { pyLower } = require('../../strategies/common/pyUnicode');
const { fmtFixed } = require('../../strategies/common/pyfmt');

const DRIP_DAYS = Object.freeze([1, 3, 5, 7]);
const LOOP_INTERVAL_S = 3600.0;
const MAX_AGE_DAYS = 8;
const THROTTLE_EVERY = 25;
const THROTTLE_S = 1.0;

const LINKS = Object.freeze({
  dashboard_show: '/app/?tab=stats',
  show_plans: '/app/?tab=settings&sec=plan',
});

const kvKey = (userId, day) => `drip_sent_day${day}_${userId}`;

/** _build_message(day, lang) → [text, [[button_text, callback_data], …]] (the bot ignores lang). */
function buildMessage(day, _lang = 'ru') {
  if (day === 1) {
    return ['👋 <b>Прошёл первый день в CHM Breaker.</b>\n\n'
      + 'За эти сутки бот:\n'
      + '  • Просканировал 150+ монет\n'
      + '  • Применил стратегии LEVELS / SMC\n'
      + "  • Отфильтровал тысячи setup'ов до лучших\n\n"
      + '💡 <b>Что попробовать:</b>\n'
      + '  • Анализ любой монеты — кнопка 🔍 в меню\n'
      + '  • Статистика своих сигналов — 📊 Мои результаты',
    [['📊 Мои результаты', 'dashboard_show']]];
  }
  if (day === 3) {
    return ['📊 <b>3 дня в боте.</b>\n\n'
      + 'Free тариф = 2 сигнала в день — для тестирования.\n'
      + 'На Pro — все сигналы LEVELS + SMC без лимитов.\n\n'
      + '⭐ <b>Pro $69/мес</b> — все функции: авто-трейд, AI-фильтр, '
      + 'оптимизатор, Strategy Genome.',
    [['⭐ Подписаться на Pro', 'show_plans']]];
  }
  if (day === 5) {
    return ['⚡ <b>5 дней — пора активировать авто-трейд?</b>\n\n'
      + 'На Free ты получаешь сигналы, но открываешь сделки руками.\n'
      + 'Это значит:\n'
      + '  ❌ Можешь пропустить точку входа\n'
      + '  ❌ Эмоции мешают: слишком рано вышел / не поставил SL\n'
      + '  ❌ Не успеваешь открыть когда видишь сигнал\n\n'
      + '⭐ <b>Pro авто-трейд:</b>\n'
      + '  ✅ Бот сам открывает по сигналу\n'
      + '  ✅ SL + 3 уровня TP автоматически\n'
      + '  ✅ Trailing stop + breakeven\n'
      + '  ✅ Защита от tilting (SL-streak guard, circuit breaker)\n\n'
      + 'Подписка через TON / промокод.',
    [['⭐ Активировать авто-трейд', 'show_plans']]];
  }
  if (day === 7) {
    return ['🎁 <b>7 дней в CHM Breaker.</b>\n\n'
      + 'За неделю ты увидел 10-20 сигналов LEVELS + SMC.\n\n'
      + '💡 <b>Если бот тебе подходит:</b>\n'
      + '  → Подпишись на Pro ($69/мес) — все функции\n\n'
      + '<i>Если хочешь остаться на Free — ничего не делай. Бот продолжит '
      + 'слать 2 сигнала в день.</i>',
    [['⭐ Активировать Pro', 'show_plans']]];
  }
  return ['', []];
}

/** _build_keyboard(buttons): one row per button, each a link to the site screen of its callback. */
function keyboard(buttons) {
  return buttons.map(([text, cb]) => [{ id: cb, label: text, action: LINKS[cb], kind: 'url', callback: cb }]);
}

// ── dependencies ─────────────────────────────────────────────────────────
function defaultDeps() {
  return {
    clock: () => Date.now() / 1000,
    dispatch: botSend.notifierDispatch(),
    kv: null,                                  // lazily engineKvService
    allRows: () => require('../../models/database')
      .prepare('SELECT user_id, sub_plan, created_at FROM trader_settings ORDER BY created_at DESC').all(),
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

const kv = () => _deps.kv || require('../engineKvService');
const log = () => _deps.log || require('../../utils/logger');
const warn = (m) => { const l = log(); (l.warning || l.warn).call(l, m); };
const debug = (m) => { const l = log(); if (l.debug) l.debug(m); };

/** _was_sent(uid, day): bool(kv value); a failing read → True (no duplicate). */
async function wasSent(userId, day) {
  try {
    const v = await kv().get(kvKey(userId, day));
    return Boolean(v);
  } catch (e) {
    debug(`_was_sent uid=${userId} day=${day}: ${botSend.errText(e)}`);
    return true;
  }
}

/** _mark_sent(uid, day): kv = str(int(time.time())); errors only logged. */
async function markSent(userId, day) {
  try {
    await kv().set(kvKey(userId, day), String(Math.trunc(_deps.clock())));
  } catch (e) {
    debug(`_mark_sent uid=${userId} day=${day}: ${botSend.errText(e)}`);
  }
}

/** _process_user(bot, user) — throws where the bot's coercions raise (the pass then stops). */
async function processUser(row) {
  const uid = pyInt(row.user_id === undefined ? 0 : row.user_id);
  if (uid <= 0) return;
  const plan = pyLower(row.sub_plan || 'free');
  if (plan !== 'free') return;
  const createdAt = pyFloat(row.created_at || 0);
  if (createdAt <= 0) return;
  const ageDays = (_deps.clock() - createdAt) / 86400;
  if (ageDays > MAX_AGE_DAYS) return;
  const currentDay = Math.trunc(ageDays) + 1;
  if (!DRIP_DAYS.includes(currentDay)) return;
  if (await wasSent(uid, currentDay)) return;
  const [text, btns] = buildMessage(currentDay);
  if (!text) return;
  try {
    const kb = keyboard(btns);
    await botSend.send(_deps.dispatch, uid, { type: 'promo', text, link: kb[0][0].action, actions: kb, silent: true });
    await markSent(uid, currentDay);
    log().info(`[DRIP-FIRE] uid=${uid} day=${currentDay} age=${fmtFixed(ageDays, 1)}d`);
  } catch (e) {
    debug(`[DRIP-SKIP] uid=${uid} day=${currentDay} send_fail: ${botSend.errText(e)}`);
  }
}

/** The body of drip_loop's try after its first sleep → {processed} | {error}. */
async function runPass({ stopped = () => false } = {}) {
  try {
    const users = await _deps.allRows();
    let n = 0;
    for (const u of users) {
      if (stopped()) return { processed: n, cancelled: true };
      await processUser(u);
      n += 1;
      if (n % THROTTLE_EVERY === 0) await _deps.sleep(THROTTLE_S * 1000);
    }
    log().info(`[DRIP] cycle done — processed=${n}`);
    return { processed: n };
  } catch (e) {
    warn(`drip_loop iteration: ${botSend.errText(e)}`);
    return { error: botSend.errText(e) };
  }
}

/** drip_loop: the start line, then every LOOP_INTERVAL_S a pass (+1 h back-off after an error). Returns stop(). */
function startLoop({ intervalS = LOOP_INTERVAL_S } = {}) {
  log().info(`[DRIP] loop started, interval=${fmtFixed(LOOP_INTERVAL_S, 0)}s`);
  let timer = null;
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    const r = await runPass({ stopped: () => stopped });
    if (stopped) return;
    timer = setTimeout(run, (r.error !== undefined ? 2 : 1) * intervalS * 1000);
  };
  timer = setTimeout(run, intervalS * 1000);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

module.exports = {
  DRIP_DAYS, LOOP_INTERVAL_S, MAX_AGE_DAYS, LINKS, kvKey, buildMessage, keyboard,
  wasSent, markSent, processUser, runPass, startLoop, configure, resetDeps,
};
