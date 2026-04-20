/**
 * Copy trading MVP — follow a public trader, mirror their signals into
 * your own paper account.
 *
 * Core flow:
 *   1. Follower POSTs /api/copy/subscribe with leader ref code
 *   2. Row in copy_subscriptions table
 *   3. When a signal from the leader fires (via autoTrade / manual trade),
 *      mirrorLeaderSignal() creates a paper trade for each follower
 *      (mode=paper only in MVP — live mode stubbed but gated off)
 *
 * Only leaders who enabled public_profile=1 are copyable — this is an
 * explicit opt-in we already built for /leaderboard.
 */

const db = require('../models/database');
const logger = require('../utils/logger');

function subscribe(followerId, { leaderCode, mode = 'paper', riskMult = 1.0 } = {}) {
  if (mode === 'live') { const e = new Error('Live copy is coming soon — use paper for now'); e.statusCode = 400; throw e; }
  if (riskMult <= 0 || riskMult > 5) { const e = new Error('risk_mult must be 0.01..5'); e.statusCode = 400; throw e; }

  const leader = db.prepare(`
    SELECT id, public_profile, display_name, referral_code
    FROM users WHERE referral_code = ? AND is_active = 1
  `).get(String(leaderCode || '').toUpperCase());
  if (!leader) { const e = new Error('Leader not found'); e.statusCode = 404; throw e; }
  if (!leader.public_profile) { const e = new Error('Leader has no public profile'); e.statusCode = 403; throw e; }
  if (leader.id === followerId) { const e = new Error('Cannot follow yourself'); e.statusCode = 400; throw e; }

  db.prepare(`
    INSERT INTO copy_subscriptions (follower_id, leader_id, mode, risk_mult)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(follower_id, leader_id) DO UPDATE
      SET mode = excluded.mode, risk_mult = excluded.risk_mult, is_active = 1
  `).run(followerId, leader.id, mode, riskMult);

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'copy.subscribe', 'user', ?, ?)
  `).run(followerId, leader.id, JSON.stringify({ leaderCode, mode, riskMult }));

  logger.info('copy subscribed', { followerId, leaderId: leader.id, mode });
  return { leaderId: leader.id, leaderName: leader.display_name || ('Trader#' + leader.referral_code.slice(0, 4)), mode, riskMult };
}

function unsubscribe(followerId, leaderId) {
  const info = db.prepare(`UPDATE copy_subscriptions SET is_active = 0 WHERE follower_id = ? AND leader_id = ?`).run(followerId, leaderId);
  return { removed: info.changes };
}

function listFollowing(followerId) {
  return db.prepare(`
    SELECT cs.leader_id, cs.mode, cs.risk_mult, cs.is_active, cs.created_at,
           u.display_name, u.referral_code,
           (SELECT COUNT(*) FROM trades t WHERE t.user_id = cs.leader_id AND t.status = 'closed') AS closed_trades,
           (SELECT COALESCE(SUM(realized_pnl), 0) FROM trades t WHERE t.user_id = cs.leader_id AND t.status = 'closed') AS total_pnl
    FROM copy_subscriptions cs JOIN users u ON u.id = cs.leader_id
    WHERE cs.follower_id = ? ORDER BY cs.created_at DESC
  `).all(followerId).map((r) => ({
    leaderId: r.leader_id, mode: r.mode, riskMult: r.risk_mult, isActive: Boolean(r.is_active),
    leaderName: r.display_name || ('Trader#' + String(r.referral_code).slice(0, 4)),
    leaderCode: r.referral_code, closedTrades: r.closed_trades, totalPnl: Number(r.total_pnl) || 0,
    createdAt: r.created_at,
  }));
}

function listFollowers(leaderId) {
  return db.prepare(`
    SELECT follower_id, mode, risk_mult, created_at
    FROM copy_subscriptions WHERE leader_id = ? AND is_active = 1
  `).all(leaderId);
}

/**
 * Called when a leader closes or opens a signal/trade — fans out to
 * every active follower as a paper mirror trade. Lightweight: doesn't
 * actually submit to exchanges, just writes a paper trade row so the
 * follower sees it on their dashboard.
 *
 * Skips gracefully (no followers / invalid follower) — never breaks
 * the leader's own trade flow.
 */
function mirrorLeaderSignal(leaderId, signal) {
  if (!signal || !signal.symbol || !signal.side || !signal.entry) return { mirrored: 0 };
  const followers = listFollowers(leaderId);
  if (!followers.length) return { mirrored: 0 };
  let ok = 0;
  for (const f of followers) {
    try {
      // Find or create a "copy-trading" bot for the follower to carry
      // the mirrored trades — keeps analytics per-leader clean.
      let bot = db.prepare(`
        SELECT id FROM trading_bots WHERE user_id = ? AND name = ?
      `).get(f.follower_id, 'copy:' + leaderId);
      if (!bot) {
        const info = db.prepare(`
          INSERT INTO trading_bots (user_id, name, exchange, symbols, strategy, timeframe,
            direction, leverage, risk_pct, max_open_trades, auto_trade, trading_mode, is_active)
          VALUES (?, ?, 'copy', '[]', 'copy', '1h', 'both', 1, 1, 10, 1, 'paper', 1)
        `).run(f.follower_id, 'copy:' + leaderId);
        bot = { id: info.lastInsertRowid };
      }
      db.prepare(`
        INSERT INTO trades (user_id, bot_id, exchange, symbol, side, strategy,
          entry_price, quantity, stop_loss, take_profit, status, trading_mode,
          opened_at, note)
        VALUES (?, ?, 'copy', ?, ?, ?, ?, ?, ?, ?, 'open', 'paper', CURRENT_TIMESTAMP, ?)
      `).run(
        f.follower_id, bot.id, signal.symbol, signal.side, signal.strategy || 'copy',
        signal.entry, f.risk_mult * 0.01,
        signal.sl || null, signal.tp || null,
        'copy-from-leader-' + leaderId,
      );
      ok += 1;
    } catch (e) { logger.warn('copy mirror failed', { followerId: f.follower_id, err: e.message }); }
  }
  return { mirrored: ok, total: followers.length };
}

module.exports = { subscribe, unsubscribe, listFollowing, listFollowers, mirrorLeaderSignal };
