/**
 * planService — the bot's subscription lifecycle (data-and-market.md §4) on
 * the site, with `subscriptions` (payments, promo codes) as the source of the
 * paid state and `trader_settings.sub_plan / sub_status / sub_expires` as the
 * bot-shaped mirror the engine reads. This module is the mirror's single
 * writer:
 *
 *   effectivePlan(userId)       — paid & live? from `subscriptions`
 *   sync(userId)                — subscriptions → mirror (called after every
 *                                 extendSubscription / activateSubscription)
 *   grantAccess(userId, days)   — bot `grant_access` base rule + sub_plan +
 *                                 plan_changes, written to both tables
 *   activateFree(userId)        — bot `plan_free_activate` (365 d free-active, LONG on)
 *   runExpiryLoop({now})        — bot loop A (hourly): auto-downgrade of expired
 *                                 paid plans + the 3d / 1d renewal reminders as
 *                                 notification rows (texts verbatim). Decision D6(c):
 *                                 loop B (`_notify_expired`) is not ported.
 *   can / planLimit / isMutualExclusionRequired(userId, …)
 *
 * Every sub_plan mutation goes to plan_changes (db/plan_audit.py semantics:
 * actor[:64], reason[:256], no-op when old == new).
 */

'use strict';

const db = require('../models/database');
const config = require('../config');
const pf = require('../config/planFeatures');
const ts = require('./traderSettingsService');
const access = require('./engine/userAccess');
const quietHours = require('./engine/quietHours');
const { stripHtml } = require('../utils/stripHtml');
const logger = require('../utils/logger');

const ADMIN_CONTACT = process.env.ADMIN_CONTACT || '@crypto_chm';   // Config.ADMIN_CONTACT
const FREE_DAYS = 365;                                              // free = "active for a year"
const PRO_PRICE_USD = pf.PLAN_PRICES_USD.pro;                       // 69
const nowSec = () => Date.now() / 1000;

// renewal.py body_text + i18n sub_expires_3d / sub_expires_1d — verbatim.
const REMINDER_TEXTS = Object.freeze({
  '3d': {
    ru: '⏰ <b>Pro заканчивается через 3 дня.</b>\nПродлить можно прямо здесь: счёт ниже, '
      + 'или в приложении → Тариф. Вопросы: {contact}',
    en: '⏰ <b>Pro ends in 3 days.</b>\nRenew right here with the invoice below, '
      + 'or in the app → Plan. Questions: {contact}',
  },
  '1d': {
    ru: '⚠️ <b>Pro заканчивается завтра.</b>\nПосле этого включится Free: 2 сигнала LEVELS в день. '
      + 'Счёт на продление ниже; вопросы: {contact}',
    en: '⚠️ <b>Pro ends tomorrow.</b>\nAfter that Free applies: 2 LEVELS signals a day. '
      + 'Renewal invoice below; questions: {contact}',
  },
  expired: {
    ru: '⏳ <b>Подписка истекла</b>\n\nВы переведены на 🆓 <b>Free план</b>: '
      + '2 сигнала LEVELS в день, одно направление.\n\n⭐ Pro $69/мес вернёт все три '
      + 'стратегии, LONG + SHORT, автотрейд и полное приложение. Вопросы: {contact}',
    en: '⏳ <b>Your subscription has expired</b>\n\nYou are on the 🆓 <b>Free plan</b>: '
      + '2 LEVELS signals a day, one direction.\n\n⭐ Pro $69/mo brings back all three '
      + 'strategies, LONG + SHORT, auto-trade and the full app. Questions: {contact}',
  },
});

// miniapp_api._PLAN_FEATURES_TEXT — verbatim.
const PLAN_FEATURES_TEXT = Object.freeze({
  ru: ['Стратегии LEVELS + SMC + Объём/MA — можно все сразу',
    'Авто-трейд без лимита позиций', 'LONG + SHORT, все таймфреймы и все монеты',
    'Безлимит сигналов и анализа монет', 'Strategy Genome (автоподбор параметров)',
    'Mini App — сигналы, графики, статистика', 'AI-фильтры сигналов',
    'Bybit + BingX + Binance + OKX'],
  en: ['LEVELS + SMC + Volume/MA strategies — all at once',
    'Auto-trade with unlimited positions', 'LONG + SHORT, all timeframes and coins',
    'Unlimited signals and coin analysis', 'Strategy Genome (auto-tuned parameters)',
    'Mini App — signals, charts, statistics', 'AI signal filters',
    'Bybit + BingX + Binance + OKX'],
});

function reminderText(kind, lang = 'ru', contact = ADMIN_CONTACT) {
  const t = REMINDER_TEXTS[kind];
  if (!t) throw new Error(`unknown reminder kind ${kind}`);
  return (lang === 'en' ? t.en : t.ru).replace('{contact}', contact);
}

// ── plan_changes audit (db/plan_audit.db_log_plan_change) ────────────────
function logPlanChange(userId, oldPlan, newPlan, { actor = '', reason = '', now = null } = {}) {
  const o = String(oldPlan || '').trim();
  const n = String(newPlan || '').trim();
  if (o === n) return false;
  const t = Math.floor(now === null || now === undefined ? nowSec() : now);
  db.prepare('INSERT INTO plan_changes (ts, user_id, old_plan, new_plan, actor, reason) VALUES (?, ?, ?, ?, ?, ?)')
    .run(t, Number(userId), o, n, String(actor).slice(0, 64), String(reason).slice(0, 256));
  return true;
}

// Site timestamps: ISO strings or SQLite CURRENT_TIMESTAMP → unix seconds (0 when empty).
function toUnixSeconds(value) {
  if (!value) return 0;
  let s = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/** The paid state according to `subscriptions` (no writes). */
function effectivePlan(userId, { now = null } = {}) {
  const t = now === null || now === undefined ? nowSec() : now;
  const row = db.prepare('SELECT plan, status, expires_at FROM subscriptions WHERE user_id = ?').get(Number(userId));
  const plan = pf.normalizePlan(row && row.plan);
  const until = toUnixSeconds(row && row.expires_at);
  const paid = plan === 'pro' && Boolean(row) && row.status === 'active' && until > t;
  return { plan: paid ? 'pro' : 'free', status: row ? row.status : null, expiresAt: until, paid, row: row || null };
}

function _writeSubscription(userId, plan, status, expiresAtSec) {
  const iso = expiresAtSec ? new Date(expiresAtSec * 1000).toISOString() : null;
  const existing = db.prepare('SELECT id FROM subscriptions WHERE user_id = ?').get(Number(userId));
  if (existing) {
    db.prepare('UPDATE subscriptions SET plan = ?, status = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?')
      .run(plan, status, iso, Number(userId));
  } else {
    db.prepare('INSERT INTO subscriptions (user_id, plan, status, expires_at) VALUES (?, ?, ?, ?)')
      .run(Number(userId), plan, status, iso);
  }
}

// ── notifications ────────────────────────────────────────────────────────
async function sendReminder(user, kind) {
  const lang = user.lang === 'en' ? 'en' : 'ru';
  const html = reminderText(kind, lang);
  const text = stripHtml(html);
  const title = text.split('\n')[0];
  let delivered = false;
  try {
    const notifier = require('./notifier');
    const r = await notifier.dispatch(user.user_id, {
      type: 'plan',
      title,
      body: text,
      link: '/subscriptions.html',
      tgText: html,
      silent: quietHours.isQuiet(user),
    });
    delivered = !(r && r.error);
  } catch (e) {
    logger.warn(`[RENEWAL] uid=${user.user_id} kind=${kind} dispatch failed: ${e.message}`);
  }
  logger.info(`[RENEWAL] uid=${user.user_id} kind=${kind} invoice=false sent=${delivered}`);
  return delivered;
}

/**
 * bot.subscription_reminder_task AUTO-DOWNGRADE branch: expired paid plan →
 * free, active for a year, LONG on, reminder flags reset, expired_notified.
 * Writes the mirror, plan_changes, the subscriptions row and (optionally)
 * sends the "expired" text.
 */
async function downgradeExpired(user, { now = null, notify = true } = {}) {
  const t = now === null || now === undefined ? nowSec() : now;
  const planNow = String(user.sub_plan || '').toLowerCase();
  user.sub_plan = 'free';
  user.sub_status = 'active';
  user.sub_expires = t + FREE_DAYS * 86400;
  user.long_active = true;
  if (!user.strategy) user.strategy = 'LEVELS';
  user.reminder_3d_sent = false;
  user.reminder_1d_sent = false;
  user.expired_notified = true;
  ts.save(user, { now: t });
  logger.info(`AUTO-DOWNGRADE uid=${user.user_id}: ${planNow} → free`);
  logPlanChange(user.user_id, planNow, 'free', { actor: 'system:auto_downgrade', reason: 'sub_expires elapsed', now: t });
  const sub = db.prepare('SELECT plan, status FROM subscriptions WHERE user_id = ?').get(Number(user.user_id));
  if (sub && (pf.normalizePlan(sub.plan) !== 'free' || sub.status !== 'expired')) {
    db.prepare("UPDATE subscriptions SET plan = 'free', status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE user_id = ?")
      .run(Number(user.user_id));
  }
  if (notify) await sendReminder(user, 'expired');
  return user;
}

/**
 * subscriptions → trader_settings mirror. Paid & live: pro/active/expires
 * (reminder flags reset like grant_access when the plan changes); not paid
 * while the mirror still says pro → the loop-A downgrade. Banned rows are
 * never touched. Returns the user.
 */
async function sync(userId, { now = null, notify = true } = {}) {
  const t = now === null || now === undefined ? nowSec() : now;
  const user = ts.getOrCreate(userId, { now: t });
  if (user.sub_status === 'banned') return user;
  const eff = effectivePlan(userId, { now: t });
  if (eff.paid) {
    const old = user.sub_plan;
    const wasPaidLive = user.sub_status === 'active' && pf.normalizePlan(old) !== 'free' && Number(user.sub_expires || 0) > t;
    user.sub_plan = 'pro';
    user.sub_status = 'active';
    user.sub_expires = eff.expiresAt;
    if (!wasPaidLive) {
      user.expired_notified = false;
      user.reminder_3d_sent = false;
      user.reminder_1d_sent = false;
    }
    ts.save(user, { now: t });
    logPlanChange(userId, old, 'pro', { actor: 'system:sync', reason: 'subscriptions mirror', now: t });
    return user;
  }
  if (pf.normalizePlan(user.sub_plan) === 'pro') return downgradeExpired(user, { now: t, notify });
  return user;
}

/**
 * Admin / payment grant: bot `grant_access(days)` (extends from the current
 * expiry only on a live paid plan) + `sub_plan` + plan_changes, mirrored to
 * `subscriptions`. {ok:false, error:'banned'} for banned users.
 */
function grantAccess(userId, days, { plan = 'pro', actor = 'admin', reason = '', now = null } = {}) {
  const t = now === null || now === undefined ? nowSec() : now;
  const user = ts.getOrCreate(userId, { now: t });
  const old = user.sub_plan;
  if (!access.grantAccess(user, days, { now: t })) return { ok: false, error: 'banned', user };
  user.sub_plan = pf.normalizePlan(plan);
  ts.save(user, { now: t });
  logPlanChange(userId, old, user.sub_plan, { actor, reason, now: t });
  _writeSubscription(userId, user.sub_plan, 'active', user.sub_expires);
  logger.info(`[PLAN] grant uid=${userId} days=${days} plan=${user.sub_plan} actor=${actor}`);
  return { ok: true, user };
}

/**
 * handlers/subscription.plan_free_activate: refused on a live Pro; otherwise
 * free / active / now+365d, LEVELS LONG on, onboarding done.
 */
function activateFree(userId, { now = null } = {}) {
  const t = now === null || now === undefined ? nowSec() : now;
  const user = ts.getOrCreate(userId, { now: t });
  if (user.sub_status === 'active' && user.sub_plan === 'pro') {
    return { ok: false, error: 'already_pro', plan_label: access.planLabel(user), user };
  }
  const old = user.sub_plan || '';
  user.sub_plan = 'free';
  user.sub_status = 'active';
  user.sub_expires = t + FREE_DAYS * 86400;
  user.long_active = true;
  if (!user.strategy) user.strategy = 'LEVELS';
  if (!user.onboarding_done) user.onboarding_done = true;
  ts.save(user, { now: t });
  logger.info(`FREE plan activated: uid=${userId}`);
  logPlanChange(userId, old, 'free', { actor: `user:${userId}`, reason: 'plan_free_activate', now: t });
  const sub = db.prepare('SELECT plan, status FROM subscriptions WHERE user_id = ?').get(Number(userId));
  if (!sub) _writeSubscription(userId, 'free', 'active', 0);
  else if (pf.normalizePlan(sub.plan) !== 'free' || sub.status !== 'active') _writeSubscription(userId, 'free', 'active', 0);
  return { ok: true, user };
}

/**
 * bot loop A (hourly): for every user — expired paid → downgrade + "expired"
 * text; live paid → "3d" / "1d" reminders (QUIRK: `elif`, a user who missed
 * the 3-day window gets "3d" first and "1d" one run later).
 */
async function runExpiryLoop({ now = null, notify = true } = {}) {
  const t = now === null || now === undefined ? nowSec() : now;
  ts.invalidateCache();
  const out = { downgraded: [], reminded3d: [], reminded1d: [] };
  for (const u of ts.allUsers({ now: t })) {
    try {
      const planNow = String(u.sub_plan || '').toLowerCase();
      if (u.sub_status === 'active' && 0 < Number(u.sub_expires) && Number(u.sub_expires) <= t && planNow !== 'free') {
        await downgradeExpired(u, { now: t, notify });
        out.downgraded.push(u.user_id);
        continue;
      }
      if (!['active', 'trial'].includes(u.sub_status) || u.sub_plan === 'free') continue;
      const left = Number(u.sub_expires) - t;
      if (0 < left && left <= 3 * 86400 && !u.reminder_3d_sent) {
        if (notify) await sendReminder(u, '3d');
        u.reminder_3d_sent = true;
        ts.save(u, { now: t });
        out.reminded3d.push(u.user_id);
      } else if (0 < left && left <= 86400 && !u.reminder_1d_sent) {
        if (notify) await sendReminder(u, '1d');
        u.reminder_1d_sent = true;
        ts.save(u, { now: t });
        out.reminded1d.push(u.user_id);
      }
    } catch (e) {
      logger.warn(`subscription_reminder_task uid=${u.user_id}: ${e.message}`);
    }
  }
  return out;
}

let _timer = null;
function startExpiryLoop({ intervalMs = 3600 * 1000, firstDelayMs = 60 * 1000 } = {}) {
  if (_timer) return;
  const tick = () => runExpiryLoop().catch((e) => logger.warn(`subscription_reminder_task error: ${e.message}`));
  _timer = setTimeout(() => {
    tick();
    _timer = setInterval(tick, intervalMs);
    if (_timer.unref) _timer.unref();
  }, firstDelayMs);
  if (_timer.unref) _timer.unref();
}

function stopExpiryLoop() {
  if (_timer) { clearTimeout(_timer); clearInterval(_timer); _timer = null; }
}

// ── per-user feature helpers ─────────────────────────────────────────────
function can(userId, feature) {
  return ts.can(ts.getOrCreate(userId), feature);
}

function planLimit(userId, feature) {
  return ts.planLimit(ts.getOrCreate(userId), feature);
}

function isMutualExclusionRequired(userId) {
  return ts.isMutualExclusionRequired(ts.getOrCreate(userId));
}

/** The site's payment methods for the `GET plan` card (no TON — decision D12). */
function paymentMethods() {
  const methods = [];
  if (config.stripeSecretKey) methods.push({ id: 'stripe', label: 'Банковская карта (Stripe)' });
  if (config.paymentBep20Address) methods.push({ id: 'usdt_bep20', label: 'USDT · BEP20 (BSC)' });
  if (config.paymentTrc20Address) methods.push({ id: 'usdt_trc20', label: 'USDT · TRC20 (Tron)' });
  return methods;
}

module.exports = {
  ADMIN_CONTACT, FREE_DAYS, PRO_PRICE_USD, REMINDER_TEXTS, PLAN_FEATURES_TEXT,
  reminderText, logPlanChange, toUnixSeconds, effectivePlan, sync, downgradeExpired,
  grantAccess, activateFree, sendReminder, runExpiryLoop, startExpiryLoop, stopExpiryLoop,
  can, planLimit, isMutualExclusionRequired, paymentMethods,
};
