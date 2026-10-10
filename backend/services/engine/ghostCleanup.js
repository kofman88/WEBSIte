'use strict';
/**
 * ghostCleanup.js — the bot's periodic "dead row" cleanup over signal_trades:
 *
 *   db/trades.py db_cleanup_ghost_trades(_all) + bot.py _ghost_cleanup_loop (300 s, then 6 h,
 *   max_age_days=3) — FIX-B3 / [SIGNAL-STATS 2026-10]:
 *     (a) result='' AND no order_id AND COALESCE(signal_msg_id,0)=0  → SKIP / FAILED / 'ghost'
 *         — a row whose card WAS delivered (signal_msg_id > 0) is not a ghost: the signal
 *         tracker owns it, and a SKIP would wipe it from the statistics;
 *     (b) result='' AND created_at < now − max_age_days AND no order_id → SKIP / FAILED / 'ghost'
 *         — [GHOST-LIVE-TRADES 2026-10] a row with an exchange order is not touched by age: the BE
 *         monitor and reconcile run the live position (their selects are result=''), a SKIP cut it
 *         off. This branch does reach delivered cards older than the window (signal-pipeline.md
 *         §12.6); signal_status() still resolves them by their tracker stage or as `expired`
 *         (rule 8 never fires for a delivered card) and COUNTABLE_SQL keeps them.
 *   cache_gc.py trades GC: DELETE SKIP / ORPHAN rows older than 30 days.
 *
 * Log lines verbatim: `ghost_cleanup: SKIP'd N no-order + M old trades`,
 * `_ghost_cleanup_loop: …`, `🧹 Trades GC: удалено N старых SKIP/ORPHAN записей`.
 */

const nowSec = () => Date.now() / 1000;

/** db_cleanup_ghost_trades(user_id, max_age_days=30) → [no_order, old] */
function cleanupGhostTrades(db, userId, { maxAgeDays = 30, now = null } = {}) {
  const t = now === null || now === undefined ? nowSec() : now;
  const cutoff = t - maxAgeDays * 86400;
  const tx = db.transaction(() => {
    const a = db.prepare(
      "UPDATE signal_trades SET result='SKIP', state='FAILED', skip_reason='ghost', "
      + 'state_changed_at=? '
      + "WHERE user_id=? AND result='' "
      + "  AND (order_id='' OR order_id IS NULL) "
      + '  AND COALESCE(signal_msg_id, 0) = 0',
    ).run(t, userId).changes;
    const b = db.prepare(
      "UPDATE signal_trades SET result='SKIP', state='FAILED', skip_reason='ghost', "
      + 'state_changed_at=? '
      + "WHERE user_id=? AND result='' AND created_at < ? "
      + "  AND (order_id='' OR order_id IS NULL)",   // [GHOST-LIVE-TRADES 2026-10]
    ).run(t, userId, cutoff).changes;
    return [a, b];
  });
  return tx();
}

/**
 * db_cleanup_ghost_trades_all(max_age_days=30) → [no_order, old] (the loop passes 3).
 * `protectDelivered: true` (NOT the bot's behaviour, off by default) also keeps branch (b) away
 * from delivered cards (`COALESCE(signal_msg_id, 0) = 0`), so no row with signal_msg_id > 0 is
 * ever rewritten — for deployments that want the [SIGNAL-STATS] intent applied to old rows too.
 */
function cleanupGhostTradesAll(db, { maxAgeDays = 30, now = null, protectDelivered = false } = {}) {
  const t = now === null || now === undefined ? nowSec() : now;
  const cutoff = t - maxAgeDays * 86400;
  const tx = db.transaction(() => {
    const a = db.prepare(
      "UPDATE signal_trades SET result='SKIP', state='FAILED', skip_reason='ghost', "
      + 'state_changed_at=? '
      + "WHERE result='' "
      + "  AND (order_id='' OR order_id IS NULL) "
      + '  AND COALESCE(signal_msg_id, 0) = 0',
    ).run(t).changes;
    const b = db.prepare(
      "UPDATE signal_trades SET result='SKIP', state='FAILED', skip_reason='ghost', "
      + 'state_changed_at=? '
      + "WHERE result='' AND created_at < ? "
      + "  AND (order_id='' OR order_id IS NULL)"   // [GHOST-LIVE-TRADES 2026-10]
      + (protectDelivered ? ' AND COALESCE(signal_msg_id, 0) = 0' : ''),
    ).run(t, cutoff).changes;
    return [a, b];
  });
  return tx();
}

/** cache_gc trades GC: DELETE SKIP / ORPHAN older than 30 days → deleted count. */
function purgeOldSkips(db, { now = null, days = 30 } = {}) {
  const t = now === null || now === undefined ? nowSec() : now;
  return db.prepare("DELETE FROM signal_trades WHERE result IN ('SKIP','ORPHAN') AND created_at < ?")
    .run(t - days * 86400).changes;
}

/** One pass of _ghost_cleanup_loop (max_age_days=3) with its log line. */
function runGhostCleanup(db, { log = null, now = null, maxAgeDays = 3, protectDelivered = false } = {}) {
  const L = log || require('../../utils/logger');
  try {
    const [totalNo, totalOld] = cleanupGhostTradesAll(db, { maxAgeDays, now, protectDelivered });
    if (totalNo || totalOld) L.info(`ghost_cleanup: SKIP'd ${totalNo} no-order + ${totalOld} old trades`);
    return [totalNo, totalOld];
  } catch (e) {
    L.warn(`_ghost_cleanup_loop: ${e.message}`);
    return [0, 0];
  }
}

/** One pass of the cache_gc trades GC with its log line. */
function runTradesGc(db, { log = null, now = null } = {}) {
  const L = log || require('../../utils/logger');
  try {
    const deleted = purgeOldSkips(db, { now });
    if (deleted) L.info(`🧹 Trades GC: удалено ${deleted} старых SKIP/ORPHAN записей`);
    return deleted;
  } catch (e) {
    if (L.debug) L.debug(`Trades GC: ${e.message}`);
    return 0;
  }
}

/** _ghost_cleanup_loop: first pass after 300 s, then every 6 h. Returns { stop }. */
function startGhostCleanupLoop(db, { log = null, firstDelayMs = 300_000, intervalMs = 6 * 3600 * 1000, protectDelivered = false } = {}) {
  let timer = null;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    runGhostCleanup(db, { log, protectDelivered });
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, firstDelayMs);
  return {
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}

module.exports = {
  cleanupGhostTrades, cleanupGhostTradesAll, purgeOldSkips, runGhostCleanup, runTradesGc, startGhostCleanupLoop,
};
