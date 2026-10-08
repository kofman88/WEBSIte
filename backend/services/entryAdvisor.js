/**
 * entryAdvisor — the bot's entry_advisor.py + handlers/entry_advisor.py, one-to-one
 * (genome-challenge-profiles.md Part 4, [ENTRY-ADVISOR 2026-10]):
 *
 * If over ENTRY_ADVISOR_DAYS (14) days a noticeable share of a strategy's delivered signals
 * ran to target without pulling back to the entry (tracker stage MISSED) and market entry
 * (`prefer_market_entry`) is off — at most once per ENTRY_ADVISOR_REPEAT_DAYS (7) one message
 * with the numbers and the «Включить вход по рынку» / «Оставить лимитный» actions
 * (kv `entry_advice_<uid>` = unix second of the last advice). ENTRY_ADVISOR_ENABLED=0 → off.
 *
 *   readConfig(env)           the module constants with the bot's clamps
 *   missedStats(uid, days)    {LEVELS|SMC|VOLUME: {missed, total}} over signal_trades (SQL verbatim)
 *   pickAdvice(stats)         (strategy, missed, total) with the highest MISSED share past the thresholds
 *   adviceText / keyboard     RU / EN verbatim
 *   adviseUser(user, now)     one check; true — the advice was sent
 *   runCycle / startLoop      the daily loop over the active users
 *   entryMarketOn / entryMarketKeep   the two button handlers (callback entry_market_on / _keep)
 *
 * I/O behind `configure(deps)`: db (better-sqlite3 handle), clock, kv {get, set}, sender
 * (uid, {text, actions, silent}) → {dispatched} | boolean (default notifier.dispatch type
 * `advice`), isQuiet(user, now), activeUsers(), getUser(uid), saveUser(user), log, sleep.
 *
 * Markers: [ENTRY-ADVISOR] uid=… <S> missed=m/t — advised market entry,
 * [ENTRY-ADVISOR] cycle: advised N users, [ENTRY-ADVISOR] cycle error: …, [ENTRY-ADVISOR] disabled.
 */

'use strict';

const { pyRoundInt, pyMax, pyMin } = require('../strategies/common/pyround');
// CPython's int() / float() / str.strip() (its Unicode digits and spaces, PEP 515, the
// 4300-digit limit, the exact error messages) — shared with the challenge port.
const { pyInt: coerceInt, pyFloat: coerceFloat, pyIntStr, pyStrip } = require('./challengeService');
const { pyUpper } = require('../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

const KV_PREFIX = 'entry_advice_';
const STRATS = Object.freeze(['LEVELS', 'SMC', 'VOLUME']);
const ACTION_ON = 'entry_market_on';
const ACTION_KEEP = 'entry_market_keep';

const isNone = (v) => v === null || v === undefined;

/** os.getenv(name, dflt) or dflt — then int()/float() raising like Python (a bad env fails the import). */
function envRaw(env, name, dflt) {
  const v = env[name] === undefined ? dflt : env[name];
  return v === '' ? dflt : v;
}

/** max(lo, int(raw)) as Python sees it: the value plus its exact decimal (ints are unbounded). */
function intAtLeast(lo, raw) {
  const s = pyIntStr(raw);
  const big = BigInt(s);
  return big > BigInt(lo) ? { n: Number(big), text: s, big } : { n: lo, text: String(lo), big: BigInt(lo) };
}

function readConfig(env = process.env) {
  const enabledRaw = envRaw(env, 'ENTRY_ADVISOR_ENABLED', '1');
  const ENABLED = !['0', 'false', 'off'].includes(pyStrip(String(enabledRaw)));
  const days = intAtLeast(3, envRaw(env, 'ENTRY_ADVISOR_DAYS', '14'));
  const cfg = {
    ENABLED,
    DAYS: days.n,
    MIN_MISSED: pyMax(2, coerceInt(envRaw(env, 'ENTRY_ADVISOR_MIN_MISSED', '5'))),
    MIN_SHARE: pyMax(0.05, pyMin(0.9, coerceFloat(envRaw(env, 'ENTRY_ADVISOR_MIN_SHARE', '0.3')))),
    REPEAT_DAYS: pyMax(1, coerceInt(envRaw(env, 'ENTRY_ADVISOR_REPEAT_DAYS', '7'))),
    INTERVAL_S: pyMax(600.0, coerceFloat(envRaw(env, 'ENTRY_ADVISOR_INTERVAL_S', '86400'))),
  };
  // f"За {DAYS} дней" prints the exact int; `time.time() - DAYS * 86400` raises OverflowError
  // once DAYS * 86400 no longer fits a float (both only for absurd ENTRY_ADVISOR_DAYS values)
  Object.defineProperty(cfg, 'DAYS_TEXT', { value: days.text, enumerable: false });
  Object.defineProperty(cfg, 'DAYS_SECONDS', { value: Number(days.big * 86400n), enumerable: false });
  return cfg;
}

let CONFIG = readConfig(process.env);

// ── dependencies ─────────────────────────────────────────────────────────
function titleOf(text) {
  return String(text).split('\n')[0].replace(/<[^>]+>/g, '').slice(0, 200);
}

/** notifier.dispatch as the default sender (type `advice`, the HTML verbatim, actions as data). */
function notifierSender() {
  return (uid, { text, actions, silent }) => require('./notifier').dispatch(uid, {
    type: 'advice', title: titleOf(text), body: text, tgText: text, link: '/app/?tab=settings&sec=risk',
    silent: Boolean(silent), data: { text, actions },
  });
}

function defaultDeps() {
  return {
    db: null,                                   // lazily models/database
    clock: () => Date.now() / 1000,
    kv: null,                                   // lazily engineKvService
    sender: null,                               // lazily notifierSender()
    isQuiet: (user, now) => require('./engine/quietHours').isQuiet(user, now),
    activeUsers: () => require('./traderSettingsService').getActiveUsers(),
    getUser: (uid) => require('./traderSettingsService').getOrCreate(uid),
    saveUser: (user) => require('./traderSettingsService').save(user),
    log: null,
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  };
}

let _deps = defaultDeps();

function configure(over = {}) {
  _deps = { ..._deps, ...over };
  if (over.config) CONFIG = { ...CONFIG, ...over.config };
  return _deps;
}

function resetDeps() {
  _deps = defaultDeps();
  CONFIG = readConfig(process.env);
}

const db = () => _deps.db || require('../models/database');
const kv = () => _deps.kv || require('./engineKvService');
const sender = () => _deps.sender || notifierSender();
const log = () => _deps.log || require('../utils/logger');
const config = () => CONFIG;

// ── stats ────────────────────────────────────────────────────────────────
/**
 * missed_stats(uid, days): {strategy: {missed, total}} over the delivered signals
 * (signal_msg_id > 0) of the last `days` days; missed = tracker stage MISSED.
 * QUIRK kept: the cutoff is the wall clock, not the caller's `now`.
 */
function missedStats(userId, days = null) {
  const d = isNone(days) ? CONFIG.DAYS : days;
  const span = isNone(days) && CONFIG.DAYS_SECONDS !== undefined ? CONFIG.DAYS_SECONDS : d * 86400;
  if (!Number.isFinite(span)) {
    const e = new Error('int too large to convert to float');
    e.pyType = 'OverflowError';
    throw e;
  }
  const cutoff = _deps.clock() - span;
  const out = {};
  for (const s of STRATS) out[s] = { missed: 0, total: 0 };
  const rows = db().prepare(
    "SELECT UPPER(COALESCE(strategy, 'LEVELS')) AS s, "
    + "SUM(CASE WHEN UPPER(COALESCE(progress_stage, ''))='MISSED' THEN 1 ELSE 0 END) AS missed, "
    + 'COUNT(*) AS total FROM signal_trades WHERE user_id=? AND created_at>=? '
    + 'AND COALESCE(signal_msg_id, 0) > 0 GROUP BY s',
  ).all(coerceInt(userId), cutoff);
  for (const row of rows) {
    const s = pyUpper(String(row.s || ''));
    if (Object.prototype.hasOwnProperty.call(out, s)) out[s] = { missed: Math.trunc(Number(row.missed || 0)), total: Math.trunc(Number(row.total || 0)) };
  }
  return out;
}

/** pick_advice(stats) → [strategy, missed, total] with the highest MISSED share, or null. */
function pickAdvice(stats) {
  let best = null;
  for (const [s, d] of Object.entries(stats || {})) {
    const m = coerceInt(d && d.missed !== undefined ? d.missed : 0);
    const t = coerceInt(d && d.total !== undefined ? d.total : 0);
    if (t <= 0 || m < CONFIG.MIN_MISSED || m / t < CONFIG.MIN_SHARE) continue;
    if (best === null || m / t > best[1] / best[2]) best = [s, m, t];
  }
  return best;
}

// ── texts ────────────────────────────────────────────────────────────────
const NAMES = Object.freeze({
  ru: { LEVELS: 'Уровни', SMC: 'SMC', VOLUME: 'Объём + MA' },
  en: { LEVELS: 'Levels', SMC: 'SMC', VOLUME: 'Volume + MA' },
});

/** html.escape(s, quote=True) */
function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function adviceText(strategy, missed, total, lang = 'ru') {
  const names = NAMES[lang === 'en' ? 'en' : 'ru'];
  const name = htmlEscape(Object.prototype.hasOwnProperty.call(names, strategy) ? names[strategy] : strategy);
  const share = pyRoundInt(100.0 * missed / pyMax(1, total));
  const days = CONFIG.DAYS_TEXT !== undefined && Number(CONFIG.DAYS_TEXT) === CONFIG.DAYS ? CONFIG.DAYS_TEXT : String(CONFIG.DAYS);
  if (lang === 'en') {
    return `🎯 <b>Entry type: ${name}</b>\n\n`
      + `Over the last ${days} days <b>${missed} of ${total}</b> ${name} signals (${share}%) `
      + 'reached the target without pulling back to the entry, so a limit order '
      + 'never filled. A market entry takes those moves at a slightly worse price.\n\n'
      + 'Turn on market entry? It applies to auto-trade; you can switch it back in '
      + 'Settings → Risk management.';
  }
  return `🎯 <b>Тип входа: ${name}</b>\n\n`
    + `За ${days} дней <b>${missed} из ${total}</b> сигналов ${name} (${share}%) ушли к цели `
    + 'без отката к входу — лимитный ордер не исполнился бы. Рыночный вход берёт такие '
    + 'движения по чуть худшей цене.\n\n'
    + 'Включить вход по рынку? Действует для автотрейда; выключить можно в '
    + 'Настройки → Риск-менеджмент.';
}

/** _keyboard(lang): the two buttons → actions (the bot's callback_data as `action`). */
function keyboard(lang = 'ru') {
  const on = lang !== 'en' ? 'Включить вход по рынку' : 'Turn on market entry';
  const no = lang !== 'en' ? 'Оставить лимитный' : 'Keep limit entry';
  return [
    { text: on, action: ACTION_ON, url: '/api/app/entry-advice/on' },
    { text: no, action: ACTION_KEEP, url: '/api/app/entry-advice/keep' },
  ];
}

const sentOk = (res) => res === true || Boolean(res && typeof res === 'object' && res.dispatched);

// ── one user ─────────────────────────────────────────────────────────────
/** advise_user(bot, user, now) → true when the advice was sent. */
async function adviseUser(user, now = null) {
  const t = isNone(now) ? _deps.clock() : now;
  const uid = coerceInt(user && user.user_id ? user.user_id : 0);      // int(getattr(user, "user_id", 0) or 0)
  if (uid <= 0 || Boolean(user.prefer_market_entry)) return false;
  let last;
  try {
    const raw = kv().get(`${KV_PREFIX}${uid}`);
    last = coerceFloat(raw === null || raw === undefined || raw === '' ? 0 : raw);
  } catch (_e) {
    last = 0.0;
  }
  if (t - last < CONFIG.REPEAT_DAYS * 86400) return false;
  const p = pickAdvice(missedStats(uid));
  if (!p) return false;
  const [strategy, missed, total] = p;
  const lang = user.lang || 'ru';
  let silent;
  try {
    silent = Boolean(_deps.isQuiet(user, t));
  } catch (_e) {
    silent = false;
  }
  const ok = sentOk(await sender()(uid, {
    text: adviceText(strategy, missed, total, lang), actions: keyboard(lang), silent, kind: 'entry_advice',
  }));
  if (ok) {
    kv().set(`${KV_PREFIX}${uid}`, String(Math.trunc(t)));
    log().info(`[ENTRY-ADVISOR] uid=${uid} ${strategy} missed=${missed}/${total} — advised market entry`);
  }
  return ok;
}

// ── loop ─────────────────────────────────────────────────────────────────
/** One pass over db_get_active_users(); returns the number of users advised. */
async function runCycle() {
  let n = 0;
  for (const row of await _deps.activeUsers()) {
    try {
      const uid = coerceInt(row && typeof row === 'object' ? row.user_id : row);
      const user = await _deps.getUser(uid);
      if (await adviseUser(user)) {
        n += 1;
        await _deps.sleep(100);
      }
    } catch (e) {
      const l = log();
      if (l.debug) l.debug(`[ENTRY-ADVISOR] uid=${row && row.user_id}: ${e && e.message}`);
    }
  }
  log().info(`[ENTRY-ADVISOR] cycle: advised ${n} users`);
  return n;
}

/** entry_advisor_loop: disabled → log + no loop; else after 600 s, every INTERVAL_S. Returns stop(). */
function startLoop({ initialDelayS = 600, intervalS = null } = {}) {
  if (!CONFIG.ENABLED) {
    log().info('[ENTRY-ADVISOR] disabled');
    return () => {};
  }
  const every = isNone(intervalS) ? CONFIG.INTERVAL_S : intervalS;
  let timer = null;
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    try {
      await runCycle();
    } catch (e) {
      log().warn(`[ENTRY-ADVISOR] cycle error: ${e && e.message}`);
    }
    if (!stopped) timer = setTimeout(run, every * 1000);
  };
  timer = setTimeout(run, initialDelayS * 1000);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

// ── the two buttons (handlers/entry_advisor.py) ──────────────────────────
/** entry_market_on: prefer_market_entry = True, save, alert, remove the keyboard. */
async function entryMarketOn(userId) {
  const user = await _deps.getUser(userId);
  const lang = user.lang || 'ru';
  user.prefer_market_entry = true;
  await _deps.saveUser(user);
  return {
    ok: true, prefer_market_entry: true, show_alert: true, remove_keyboard: true,
    message: lang !== 'en' ? '🎯 Вход по рынку включён' : '🎯 Market entry is on',
  };
}

/** entry_market_keep: toast «Оставляем лимитный вход» (RU for every language), remove the keyboard. */
async function entryMarketKeep() {
  return { ok: true, show_alert: false, remove_keyboard: true, message: 'Оставляем лимитный вход' };
}

module.exports = {
  KV_PREFIX, STRATS, ACTION_ON, ACTION_KEEP, NAMES,
  readConfig, config, configure, resetDeps,
  missedStats, pickAdvice, adviceText, keyboard, htmlEscape, adviseUser, runCycle, startLoop,
  entryMarketOn, entryMarketKeep,
};
