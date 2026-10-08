'use strict';
/**
 * reports.js — the bot's two scheduled reports (signal-pipeline.md §13–14), texts verbatim:
 *
 *   daily_summary.py  23:55 UTC to every user with auto_trade on: exchange trades of the day
 *                     (db_get_auto_stats_period 1 / 7) → "🌙 Твой день — …" (Russian for every
 *                     language, only the month name follows `lang`), + the challenge progress
 *                     line hook. QUIRK kept: the user counts as "sent" whatever the sender
 *                     answered (only an exception makes it a skip).
 *   weekly_digest.py  Monday 09:05 UTC (WEEKLY_DIGEST_WEEKDAY/HOUR_UTC/MINUTE_UTC), every user
 *                     with a signal in 7 days (signal_stats(uid, 7)), free users get the Pro
 *                     line (pro_overview(7)); kv `weekly_digest_last_week` = ISO week dedups
 *                     restarts; WEEKLY_DIGEST_ENABLED=0 switches it off.
 *
 * Delivery goes through an injectable `sender(uid, message)` — by default notifier.dispatch
 * with type `report` (in-app + e-mail + Telegram mirror; the bot's Mini App button becomes the
 * notification link `/app/?tab=stats`). Clock, sleep, users, kv and the stats functions are
 * injectable; production wiring uses traderSettingsService, engineKvService and signalStats.
 *
 * Markers: [DAILY-SUMMARY] uid=… sent=True trades=… rr=…, [DAILY-SUMMARY] iteration: …,
 * [WEEKLY-DIGEST] uid=… sent=… signals=… rr=…, [WEEKLY-DIGEST] iteration: …,
 * [WEEKLY-DIGEST] week … already sent — skip.
 */

const { pyInt, pyFloat } = require('./pycoerce');
const { fmtFixed, fmtSigned, pyRepr } = require('../../strategies/common/pyfmt');
const { pyRoundInt } = require('../../strategies/common/pyround');

const pyBoolStr = (b) => (b ? 'True' : 'False');
const falsy = (v) => v === null || v === undefined || v === false || v === 0 || v === '';
const intOr0 = (v) => (falsy(v) ? 0 : pyInt(v));         // int(x or 0)
const floatOr0 = (v) => (falsy(v) ? 0.0 : pyFloat(v));   // float(x or 0)
const getOr = (o, k, d) => (o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined ? o[k] : d);
const replaceAll = (s, a, b) => String(s).split(a).join(b);

// ═══════════════════════════════════════════════════════════════════════
//  daily_summary.py
// ═══════════════════════════════════════════════════════════════════════

const DAILY_SUMMARY_HOUR_UTC = 23;
const DAILY_SUMMARY_MINUTE_UTC = 55;
const dailyEnabled = (env = process.env) => String(env.DAILY_SUMMARY_ENABLED === undefined ? '1' : env.DAILY_SUMMARY_ENABLED).trim() !== '0';

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RU_MONTHS = Object.freeze({
  January: 'января', February: 'февраля', March: 'марта', April: 'апреля', May: 'мая', June: 'июня',
  July: 'июля', August: 'августа', September: 'сентября', October: 'октября', November: 'ноября', December: 'декабря',
});

/** _seconds_until_next_summary(): seconds to the next 23:55:00 UTC (strictly in the future). */
function secondsUntilNextSummary(now) {
  const d = new Date(now * 1000);
  let target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DAILY_SUMMARY_HOUR_UTC, DAILY_SUMMARY_MINUTE_UTC) / 1000;
  if (target <= now) target += 86400;
  return target - now;
}

/** datetime.now(timezone.utc).strftime("%d %B") (+ the Russian month when lang == "ru"). */
function todayDate(now, lang) {
  const d = new Date(now * 1000);
  const month = EN_MONTHS[d.getUTCMonth()];
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${day} ${lang === 'ru' ? RU_MONTHS[month] : month}`;
}

/** _format_summary(stats_24h, stats_7d, lang) → text | null (no closed trades today). */
function formatSummary(stats24h, stats7d, lang = 'ru', now = null) {
  const t = now === null || now === undefined ? Date.now() / 1000 : now;
  const s24 = stats24h || {};
  const s7 = stats7d || {};
  const closed24 = intOr0(getOr(s24, 'closed', 0));
  if (closed24 === 0) return null;
  const NL = '\n';
  const date = todayDate(t, lang);
  const tp1 = intOr0(getOr(s24, 'tp1', 0));
  const tp2 = intOr0(getOr(s24, 'tp2', 0));
  const tp3 = intOr0(getOr(s24, 'tp3', 0));
  const sl = intOr0(getOr(s24, 'sl', 0));
  const be = intOr0(getOr(s24, 'be', 0));
  const rr = floatOr0(getOr(s24, 'total_rr', 0));
  const wr = floatOr0(getOr(s24, 'winrate_pct', 0));
  const tpTotal = tp1 + tp2 + tp3;
  const rrSign = rr >= 0 ? '+' : '';
  const rr7 = floatOr0(getOr(s7, 'total_rr', 0));
  const wr7 = floatOr0(getOr(s7, 'winrate_pct', 0));
  const closed7 = intOr0(getOr(s7, 'closed', 0));
  const rr7Sign = rr7 >= 0 ? '+' : '';
  let dayEmoji; let dayMsg;
  if (rr > 1.0) { dayEmoji = '🔥'; dayMsg = 'Отличный день'; } else if (rr > 0) { dayEmoji = '✅'; dayMsg = 'Положительный день'; } else if (rr > -1.0) { dayEmoji = '💤'; dayMsg = 'Спокойный день'; } else { dayEmoji = '📉'; dayMsg = 'Тяжёлый день'; }
  const lines = [
    `🌙 <b>Твой день — ${date}</b>`,
    '',
    `${dayEmoji} <b>${dayMsg}</b>`,
    `📊 Сделок: <b>${closed24}</b> (${tpTotal} ✅ / ${sl} ❌` + (be ? ` / ${be} ♻️` : '') + ')',
    `💰 Результат: <b>${rrSign}${fmtFixed(rr, 2)}R</b>`,
    `🎯 Win Rate: <b>${fmtFixed(wr, 0)}%</b>`,
  ];
  const best = getOr(s24, 'best_symbol', '');
  const worst = getOr(s24, 'worst_symbol', '');
  if (best) lines.push(`🏆 Лучшая: <b>${replaceAll(replaceAll(best, '-USDT-SWAP', ''), '-USDT', '')}</b>`);
  if (worst && worst !== best) lines.push(`📉 Худшая: <b>${replaceAll(replaceAll(worst, '-USDT-SWAP', ''), '-USDT', '')}</b>`);
  if (closed7 >= 3) {
    lines.push('');
    lines.push(`📅 За 7 дней: <b>${rr7Sign}${fmtFixed(rr7, 2)}R</b> | WR ${fmtFixed(wr7, 0)}% (${closed7} сделок)`);
  }
  lines.push('');
  lines.push(rr > 0 ? '😴 Хорошо отдохнуть!' : '💪 Завтра новый день — без эмоций.');
  return lines.join(NL);
}

// ═══════════════════════════════════════════════════════════════════════
//  weekly_digest.py
// ═══════════════════════════════════════════════════════════════════════

function envInt(env, name, dflt) {
  const raw = env[name];
  try { return pyInt(falsy(raw) ? String(dflt) : raw); } catch (_e) { return dflt; }
}

/** WEEKLY_DIGEST_* env (int(os.environ.get(…) or default) % N). */
function readWeeklyConfig(env = process.env) {
  const mod = (a, n) => ((a % n) + n) % n;
  return Object.freeze({
    ENABLED: String(env.WEEKLY_DIGEST_ENABLED === undefined ? '1' : env.WEEKLY_DIGEST_ENABLED).trim() !== '0',
    WEEKDAY: mod(envInt(env, 'WEEKLY_DIGEST_WEEKDAY', 0), 7),
    HOUR_UTC: mod(envInt(env, 'WEEKLY_DIGEST_HOUR_UTC', 9), 24),
    MINUTE_UTC: mod(envInt(env, 'WEEKLY_DIGEST_MINUTE_UTC', 5), 60),
  });
}

const KV_LAST_WEEK = 'weekly_digest_last_week';
const SEND_PAUSE_S = 0.5;

const T = Object.freeze({
  ru: Object.freeze({
    title: '📊 <b>Итоги недели</b> · {period}',
    signals: 'Сигналов: <b>{n}</b> · в плюс {w} · в минус {l}{be}{exp}',
    be: ' · безубыток {n}',
    exp: ' · без итога {n}',
    total: 'Итог: <b>{rr}</b> · win rate {wr}%',
    total_none: 'Итог: пока без закрытых сигналов',
    best: 'Лучший: {sym} {dir} {rr}',
    open: 'В работе сейчас: {n}',
    by_strat: 'По стратегиям: {parts}',
    pro: '⭐ Pro на этой неделе: в среднем {avg} сигналов на юзера, {rr} по {n} уникальным сигналам. У тебя — {mine}.',
    btn: '📱 Открыть статистику',
    foot: 'Новая неделя — новые сетапы. Удачи!',
  }),
  en: Object.freeze({
    title: '📊 <b>Weekly recap</b> · {period}',
    signals: 'Signals: <b>{n}</b> · wins {w} · losses {l}{be}{exp}',
    be: ' · break-even {n}',
    exp: ' · no outcome {n}',
    total: 'Result: <b>{rr}</b> · win rate {wr}%',
    total_none: 'Result: no closed signals yet',
    best: 'Best: {sym} {dir} {rr}',
    open: 'Still running: {n}',
    by_strat: 'By strategy: {parts}',
    pro: '⭐ Pro this week: {avg} signals per user on average, {rr} across {n} unique signals. You got {mine}.',
    btn: '📱 Open stats',
    foot: 'New week, new setups. Good luck!',
  }),
});

/** str.format with named fields (no format specs are used by the templates). */
function fmt(tpl, vals) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vals, k) ? String(vals[k]) : m));
}

/** _r(x): f"{x:+.1f}R" with ±0.0R → 0R. */
function r(x) {
  return `${fmtSigned(x, 1)}R`.replace('+0.0R', '0R').replace('-0.0R', '0R');
}

/** f"{v}" of a Python number (floats print with repr, ints as digits). */
function pyStrNum(v) {
  if (typeof v !== 'number') return String(v);
  return pyRepr(v);
}

const utcDay = (now) => Math.floor(now / 86400) * 86400;
const ddmm = (ts) => {
  const d = new Date(ts * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** _period(now): "{start:%d.%m} – {end:%d.%m}", end = now − 1 day, start = end − 6 days. */
function period(now) {
  const end = now - 86400;
  const start = end - 6 * 86400;
  return `${ddmm(start)} – ${ddmm(end)}`;
}

/** week_key(now): "{ISO year}-W{ISO week:02d}". */
function weekKey(now) {
  const d = new Date(utcDay(now) * 1000);
  const dow = (d.getUTCDay() + 6) % 7;                          // Monday = 0
  const thursday = new Date(d.getTime() + (3 - dow) * 86400000);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = jan4.getTime() - jan4Dow * 86400000;
  const week = Math.floor((d.getTime() - dow * 86400000 - week1Monday) / (7 * 86400000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** seconds_until_next(now): next WEEKDAY HH:MM UTC strictly after now, ≥ 1 s. */
function secondsUntilNext(now, cfg = readWeeklyConfig()) {
  const d = new Date(now * 1000);
  let target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), cfg.HOUR_UTC, cfg.MINUTE_UTC) / 1000;
  const wd = (new Date(target * 1000).getUTCDay() + 6) % 7;
  target += (((cfg.WEEKDAY - wd) % 7) + 7) % 7 * 86400;
  if (target <= now) target += 7 * 86400;
  return Math.max(1.0, target - now);
}

/** format_digest(stats, lang, plan, pro, now) → text | null (no signals this week). */
function formatDigest(stats, lang = 'ru', plan = 'pro', pro = null, now = null) {
  const s = stats || {};
  if (intOr0(getOr(s, 'signals', 0)) <= 0) return null;
  const t = T[Object.prototype.hasOwnProperty.call(T, lang) ? lang : 'ru'];
  const n = now === null || now === undefined ? Date.now() / 1000 : now;
  const lines = [fmt(t.title, { period: period(n) })];
  const be = intOr0(getOr(s, 'be', 0));
  const exp = intOr0(getOr(s, 'expired', 0));
  lines.push(fmt(t.signals, {
    n: pyInt(getOr(s, 'signals', 0)), w: pyInt(getOr(s, 'wins', 0)), l: pyInt(getOr(s, 'losses', 0)),
    be: be ? fmt(t.be, { n: be }) : '', exp: exp ? fmt(t.exp, { n: exp }) : '',
  }));
  if (intOr0(getOr(s, 'trades', 0)) > 0) {
    lines.push(fmt(t.total, { rr: r(pyFloat(getOr(s, 'total_rr', 0.0))), wr: pyRoundInt(pyFloat(getOr(s, 'win_rate', 0.0))) }));
    const bestRr = getOr(s, 'best_rr', null);
    if (bestRr !== null && getOr(s, 'best_symbol', null)) {
      lines.push(fmt(t.best, { sym: s.best_symbol, dir: getOr(s, 'best_direction', ''), rr: r(pyFloat(bestRr)) }));
    }
  } else {
    lines.push(t.total_none);
  }
  if (intOr0(getOr(s, 'open', 0))) lines.push(fmt(t.open, { n: pyInt(s.open) }));
  const parts = [];
  for (const [name, b] of Object.entries(getOr(s, 'per_strategy', null) || {})) {
    if (intOr0(getOr(b, 'signals', 0))) parts.push(`${name} ${r(pyFloat(getOr(b, 'total_rr', 0.0)))} (${pyInt(getOr(b, 'trades', 0))})`);
  }
  if (parts.length > 1) lines.push(fmt(t.by_strat, { parts: parts.join(' · ') }));
  if (String(plan || '').toLowerCase() === 'free' && pro && intOr0(getOr(pro, 'pro_users', 0)) > 0) {
    lines.push('');
    lines.push(fmt(t.pro, {
      avg: pyStrNum(getOr(pro, 'avg_signals', 0)), rr: r(pyFloat(getOr(pro, 'unique_rr', 0.0))),
      n: pyInt(getOr(pro, 'unique_signals', 0)), mine: pyInt(getOr(s, 'signals', 0)),
    }));
  }
  lines.push('');
  lines.push(t.foot);
  return lines.join('\n');
}

/** app_keyboard(lang) on the web: the button → an action link to the stats screen. */
function appActions(lang = 'ru') {
  const t = T[Object.prototype.hasOwnProperty.call(T, lang) ? lang : 'ru'];
  return [{ text: t.btn, url: '/app/?tab=stats' }];
}

// ═══════════════════════════════════════════════════════════════════════
//  delivery + loops
// ═══════════════════════════════════════════════════════════════════════

const STATS_LINK = '/app/?tab=stats';

function titleOf(text) {
  return String(text).split('\n')[0].replace(/<[^>]+>/g, '').slice(0, 200);
}

/**
 * The e-mail rendering of a report: the generic template would escape the Telegram-HTML
 * subset (<b>/<i>/<code>), so the report goes out as its own HTML (line breaks kept) with a
 * tag-free plain-text part.
 */
function emailTemplate(text) {
  const subject = titleOf(text);
  const plain = String(text).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const html = '<div style="font-family:-apple-system,\'Inter\',sans-serif;color:#E5E5E5;background:#0A0A0A;padding:32px">'
    + '<div style="max-width:560px;margin:0 auto;background:#121626;border-radius:16px;padding:32px;border:1px solid #1f2937;line-height:1.6">'
    + `${String(text).split('\n').join('<br>')}</div></div>`;
  return { subject, text: plain, html };
}

/** notifier.dispatch as the default sender: type report, text verbatim (HTML). */
function notifierSender(notifier = null) {
  const n = notifier || require('../notifier');
  return (uid, { text, actions = null }) => n.dispatch(uid, {
    type: 'report', title: titleOf(text), body: text, tgText: text, link: STATS_LINK,
    template: emailTemplate(text), data: { text, actions },
  });
}

const sentOk = (res) => res === true || Boolean(res && res.dispatched);

/**
 * createReports(deps):
 *   db            better-sqlite3 handle (signal_trades / trader_settings) for the default stats
 *   sender        (uid, {text, actions, kind}) → {dispatched} | boolean   (default notifier)
 *   allUsers      () → rows with user_id / auto_trade   (traderSettingsService.allUsers)
 *   getUser       uid → user | null                     (traderSettingsService.get)
 *   kv            { get(key), set(key, value) }          (engineKvService)
 *   challengeLine (user, now) → string | null            ([CHALLENGE] daily line hook)
 *   stats         { autoStatsPeriod(uid, days, now), signalStats(uid, days, now), proOverview(days, now) }
 *   log, sleep(ms), clock() → unix s, env
 */
function createReports(deps = {}) {
  const log = deps.log || require('../../utils/logger');
  const sleep = deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
  const clock = deps.clock || (() => Date.now() / 1000);
  const env = deps.env || process.env;
  const weeklyCfg = readWeeklyConfig(env);
  const ts = () => require('../traderSettingsService');
  const allUsers = deps.allUsers || (() => ts().allUsers());
  const getUser = deps.getUser || ((uid) => ts().get(uid));
  const kv = deps.kv || require('../engineKvService');
  const sender = deps.sender || notifierSender(deps.notifier);
  const SS = () => require('./signalStats');
  const stats = {
    autoStatsPeriod: (uid, days, now) => SS().autoStatsPeriod(deps.db, uid, days, now),
    signalStats: (uid, days, now) => SS().signalStats(deps.db, uid, days, now),
    proOverview: (days, now) => SS().proOverview(deps.db, days, now),
    ...(deps.stats || {}),
  };
  const debug = (m) => (log.debug ? log.debug(m) : undefined);
  const timers = { daily: null, weekly: null };

  /** _build_and_send_for_user(bot, user) → sent? */
  async function buildAndSendDaily(user, now = null) {
    const t = now || clock();
    try {
      const uid = user.user_id;
      const s24 = await stats.autoStatsPeriod(uid, 1, t);
      if (!s24 || !Object.keys(s24).length) return false;
      const s7 = await stats.autoStatsPeriod(uid, 7, t);
      const lang = falsy(user.lang) ? 'ru' : user.lang;
      let text = formatSummary(s24, s7 || {}, lang, t);
      if (!text) return false;                                   // 0 trades today — skip
      try {
        if (typeof deps.challengeLine === 'function') {
          const line = await deps.challengeLine(user, t);
          if (line) text += `\n\n${line}`;
        }
      } catch (e) {
        debug(`daily summary challenge uid=${uid}: ${e.message}`);
      }
      try {
        await sender(uid, { text, kind: 'daily' });              // QUIRK: the answer is not checked
      } catch (e) {
        debug(`daily summary send uid=${uid}: ${e.message}`);
        return false;
      }
      log.info(`[DAILY-SUMMARY] uid=${uid} sent=True trades=${intOr0(getOr(s24, 'closed', 0))} rr=${fmtFixed(floatOr0(getOr(s24, 'total_rr', 0)), 2)}`);
      return true;
    } catch (e) {
      debug(`daily summary uid=${user && user.user_id !== undefined ? user.user_id : '?'}: ${e.message}`);
      return false;
    }
  }

  /** One daily_summary_loop iteration (after the sleep until 23:55). → [sent, skipped] */
  async function runDaily(now = null) {
    const t = now || clock();
    let rows;
    try {
      rows = await allUsers();
    } catch (e) {
      log.warn(`[DAILY-SUMMARY] cannot load users: ${e.message}`);
      rows = [];
    }
    let sent = 0; let skipped = 0;
    for (const row of rows) {
      try {
        if (!row.auto_trade) { skipped += 1; continue; }
        const user = await getUser(pyInt(row.user_id));
        if (!user) { skipped += 1; continue; }
        if (await buildAndSendDaily(user, t)) sent += 1; else skipped += 1;
        await sleep(500);                                        // rate-limit
      } catch (e) {
        debug(`[DAILY-SUMMARY] user iter: ${e.message}`);
      }
    }
    log.info(`[DAILY-SUMMARY] iteration: sent=${sent} skipped=${skipped} total=${rows.length}`);
    return [sent, skipped];
  }

  /** send_for_user(bot, user, pro, now) → sent? */
  async function sendWeeklyForUser(user, pro = null, now = null) {
    const t = now || clock();
    try {
      const uid = intOr0(user.user_id);
      const st = await stats.signalStats(uid, 7, t);
      const lang = falsy(user.lang) ? 'ru' : user.lang;
      const plan = falsy(user.sub_plan) ? '' : String(user.sub_plan);
      const text = formatDigest(st, lang, plan, pro, t);
      if (!text) return false;
      const ok = sentOk(await sender(uid, { text, kind: 'weekly', actions: appActions(lang) }));
      log.info(`[WEEKLY-DIGEST] uid=${uid} sent=${pyBoolStr(ok)} signals=${pyInt(getOr(st, 'signals', 0))} rr=${fmtFixed(pyFloat(getOr(st, 'total_rr', 0.0)), 2)}`);
      return ok;
    } catch (e) {
      debug(`[WEEKLY-DIGEST] uid=${user && user.user_id !== undefined ? user.user_id : '?'}: ${e.message}`);
      return false;
    }
  }

  /** run_once(bot, um, now) → [sent, skipped] */
  async function runWeekly(now = null) {
    const t = now || clock();
    let pro = null;
    try {
      pro = await stats.proOverview(7, t);
    } catch (e) {
      debug(`[WEEKLY-DIGEST] pro overview: ${e.message}`);
      pro = null;
    }
    let rows;
    try {
      rows = await allUsers();
    } catch (e) {
      log.warn(`[WEEKLY-DIGEST] cannot load users: ${e.message}`);
      return [0, 0];
    }
    let sent = 0; let skipped = 0;
    for (const row of rows) {
      try {
        const user = await getUser(pyInt(row.user_id));
        if (!user) { skipped += 1; continue; }
        if (await sendWeeklyForUser(user, pro, t)) {
          sent += 1;
          await sleep(SEND_PAUSE_S * 1000);
        } else {
          skipped += 1;
        }
      } catch (e) {
        debug(`[WEEKLY-DIGEST] user iter: ${e.message}`);
        skipped += 1;
      }
    }
    log.info(`[WEEKLY-DIGEST] iteration: sent=${sent} skipped=${skipped} total=${rows.length}`);
    return [sent, skipped];
  }

  /** One weekly_digest_loop tick at the scheduled time: kv dedup per ISO week, then run_once. */
  async function weeklyTick(now = null) {
    const t = now || clock();
    const wk = weekKey(t);
    if ((await kv.get(KV_LAST_WEEK) || '') === wk) {
      log.info(`[WEEKLY-DIGEST] week ${wk} already sent — skip`);
      return null;
    }
    await kv.set(KV_LAST_WEEK, wk);
    return runWeekly(t);
  }

  function startDaily() {
    if (!dailyEnabled(env)) {
      log.info('[DAILY-SUMMARY] disabled via env DAILY_SUMMARY_ENABLED=0');
      return false;
    }
    log.info(`[DAILY-SUMMARY] loop started, next run in ${fmtFixed(secondsUntilNextSummary(clock()), 0)}s`);
    const arm = () => {
      timers.daily = setTimeout(async () => {
        try {
          await runDaily();
          arm();
        } catch (e) {
          log.warn(`[DAILY-SUMMARY] iteration error: ${e.message}`);
          timers.daily = setTimeout(arm, 3600 * 1000);          // crash-loop guard
        }
      }, secondsUntilNextSummary(clock()) * 1000);
    };
    arm();
    return true;
  }

  function startWeekly() {
    if (!weeklyCfg.ENABLED) {
      log.info('[WEEKLY-DIGEST] disabled via env WEEKLY_DIGEST_ENABLED=0');
      return false;
    }
    const pad = (x) => String(x).padStart(2, '0');
    log.info(`[WEEKLY-DIGEST] loop started, next run in ${fmtFixed(secondsUntilNext(clock(), weeklyCfg), 0)}s `
      + `(weekday=${weeklyCfg.WEEKDAY} ${pad(weeklyCfg.HOUR_UTC)}:${pad(weeklyCfg.MINUTE_UTC)} UTC)`);
    const arm = () => {
      timers.weekly = setTimeout(async () => {
        try {
          await weeklyTick();
          arm();
        } catch (e) {
          log.warn(`[WEEKLY-DIGEST] iteration error: ${e.message}`);
          timers.weekly = setTimeout(arm, 3600 * 1000);
        }
      }, secondsUntilNext(clock(), weeklyCfg) * 1000);
    };
    arm();
    return true;
  }

  function stop() {
    for (const k of Object.keys(timers)) {
      if (timers[k]) clearTimeout(timers[k]);
      timers[k] = null;
    }
  }

  return {
    weeklyCfg, buildAndSendDaily, runDaily, sendWeeklyForUser, runWeekly, weeklyTick, startDaily, startWeekly, stop,
  };
}

module.exports = {
  DAILY_SUMMARY_HOUR_UTC, DAILY_SUMMARY_MINUTE_UTC, KV_LAST_WEEK, SEND_PAUSE_S, T, STATS_LINK,
  dailyEnabled, secondsUntilNextSummary, todayDate, formatSummary,
  readWeeklyConfig, r, period, weekKey, secondsUntilNext, formatDigest, appActions,
  notifierSender, emailTemplate, createReports,
};
