/**
 * Leaderboard — public ranking of traders by closed-trade performance.
 *
 * Privacy: only users who opted in (users.public_profile = 1) appear.
 * Display name: takes display_name if set, otherwise anonymizes as
 * "Trader#XXXX" using first 4 chars of the referral_code.
 *
 * Sort options:
 *   pnl      — absolute USD realized PnL (default)
 *   winrate  — % wins (min 10 closed trades to qualify)
 *   sharpe   — simplified: mean(pnl_pct) / stddev(pnl_pct) * sqrt(252)
 *              (annualized on daily steps — approximation, real math
 *              would need per-trade duration weighting; this is
 *              marketing-grade good enough)
 *   roi      — totalPnl / grossStake (avg margin_used × trades count)
 */

const db = require('../models/database');

const MIN_TRADES_FOR_RATE = 10;

function _dateClause(period) {
  if (period === 'all') return { where: '', params: [] };
  const days = { '30d': 30, '7d': 7, '90d': 90, '1y': 365 }[period] || 30;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return { where: 'AND t.closed_at >= ?', params: [since] };
}

function topTraders({ period = '30d', sort = 'pnl', limit = 50 } = {}) {
  const dc = _dateClause(period);
  // Group by user_id — this can be heavy with many users; index on (user_id, status)
  // already exists. For a small site this is O(n_trades); acceptable <1M trades.
  const rows = db.prepare(`
    SELECT
      u.id AS user_id,
      u.display_name,
      u.referral_code,
      u.created_at AS joined_at,
      COUNT(*) AS closed_trades,
      SUM(CASE WHEN t.realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN t.realized_pnl < 0 THEN 1 ELSE 0 END) AS losses,
      COALESCE(SUM(t.realized_pnl), 0) AS total_pnl,
      COALESCE(AVG(t.realized_pnl_pct), 0) AS mean_pnl_pct,
      COALESCE(AVG(t.margin_used), 0) AS avg_margin
    FROM users u
    JOIN trades t ON t.user_id = u.id
    WHERE u.public_profile = 1 AND u.is_active = 1
      AND t.status = 'closed' AND t.realized_pnl IS NOT NULL
      ${dc.where}
    GROUP BY u.id
    HAVING closed_trades >= 3
  `).all(...dc.params);

  // Compute derived metrics + optionally filter by min-trades for rate-based sorts
  const enhanced = rows.map((r) => {
    const closed = r.closed_trades || 0;
    const wr = closed ? r.wins / closed : 0;
    // Stddev for sharpe — separate query per user (only if sorting by sharpe to avoid cost)
    let sharpe = null;
    if (sort === 'sharpe' && closed >= MIN_TRADES_FOR_RATE) {
      sharpe = _sharpeFor(r.user_id, dc);
    }
    const roi = r.avg_margin > 0 && closed > 0 ? (r.total_pnl / (r.avg_margin * closed)) * 100 : 0;
    return {
      userId: r.user_id,
      displayName: r.display_name || ('Trader#' + String(r.referral_code || '').slice(0, 4).toUpperCase()),
      referralCode: r.referral_code,
      joinedAt: r.joined_at,
      closedTrades: closed,
      wins: r.wins || 0,
      losses: r.losses || 0,
      winRate: wr,
      totalPnl: Number(r.total_pnl) || 0,
      meanPnlPct: Number(r.mean_pnl_pct) || 0,
      roi: Math.round(roi * 100) / 100,
      sharpe: sharpe !== null ? Math.round(sharpe * 100) / 100 : null,
    };
  });

  // Sorting
  let filtered = enhanced;
  if (sort === 'winrate' || sort === 'sharpe') {
    filtered = enhanced.filter((r) => r.closedTrades >= MIN_TRADES_FOR_RATE);
  }
  const cmp = {
    pnl:     (a, b) => b.totalPnl - a.totalPnl,
    winrate: (a, b) => b.winRate - a.winRate,
    roi:     (a, b) => b.roi - a.roi,
    sharpe:  (a, b) => (b.sharpe || -Infinity) - (a.sharpe || -Infinity),
  }[sort] || ((a, b) => b.totalPnl - a.totalPnl);
  filtered.sort(cmp);
  return filtered.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
}

function _sharpeFor(userId, dc) {
  const pcts = db.prepare(`
    SELECT realized_pnl_pct FROM trades
    WHERE user_id = ? AND status = 'closed' AND realized_pnl_pct IS NOT NULL
          ${dc.where.replace(/AND t\./g, 'AND ')}
  `).all(userId, ...dc.params).map((r) => Number(r.realized_pnl_pct) || 0);
  if (pcts.length < 2) return 0;
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const variance = pcts.reduce((s, x) => s + (x - mean) ** 2, 0) / (pcts.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  // Per-trade sharpe × sqrt(trades_per_year estimate) — rough scaling
  return (mean / sd) * Math.sqrt(252);
}

/**
 * Public profile — stats for a single user by referral_code (case-insensitive).
 * Returns null if user doesn't exist or has public_profile=0.
 */
function publicProfile(referralCode) {
  const row = db.prepare(`
    SELECT id, display_name, referral_code, created_at, public_profile
    FROM users
    WHERE referral_code = ? AND is_active = 1
  `).get(String(referralCode || '').toUpperCase());
  if (!row || !row.public_profile) return null;

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS closed_trades,
      COALESCE(SUM(realized_pnl), 0) AS total_pnl,
      SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) AS losses,
      COALESCE(AVG(realized_pnl_pct), 0) AS mean_pnl_pct
    FROM trades WHERE user_id = ? AND status = 'closed' AND realized_pnl IS NOT NULL
  `).get(row.id);

  const byStrat = db.prepare(`
    SELECT COALESCE(strategy, 'unknown') AS strategy,
           COUNT(*) AS trades, SUM(realized_pnl) AS pnl,
           SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins
    FROM trades WHERE user_id = ? AND status = 'closed'
    GROUP BY strategy ORDER BY pnl DESC
  `).all(row.id);

  // Last 30 closed trades — anonymized (no exit price shown, just side + pnl%)
  const recent = db.prepare(`
    SELECT symbol, side, strategy, realized_pnl_pct, closed_at
    FROM trades WHERE user_id = ? AND status = 'closed' AND realized_pnl_pct IS NOT NULL
    ORDER BY closed_at DESC LIMIT 30
  `).all(row.id);

  const closed = totals.closed_trades || 0;
  return {
    displayName: row.display_name || ('Trader#' + String(row.referral_code).slice(0, 4).toUpperCase()),
    referralCode: row.referral_code,
    joinedAt: row.created_at,
    stats: {
      closedTrades: closed,
      wins: totals.wins || 0,
      losses: totals.losses || 0,
      winRate: closed ? totals.wins / closed : null,
      totalPnl: Number(totals.total_pnl) || 0,
      meanPnlPct: Number(totals.mean_pnl_pct) || 0,
    },
    byStrategy: byStrat.map((s) => {
      const stClosed = (s.wins || 0) + Math.max(0, (s.trades || 0) - (s.wins || 0));
      return {
        strategy: s.strategy,
        trades: s.trades || 0,
        pnl: Number(s.pnl) || 0,
        winRate: stClosed ? s.wins / stClosed : null,
      };
    }),
    recent: recent.map((r) => ({
      symbol: r.symbol, side: r.side, strategy: r.strategy,
      pnlPct: Number(r.realized_pnl_pct) || 0,
      closedAt: r.closed_at,
    })),
  };
}

function setPublicProfile(userId, enabled) {
  db.prepare('UPDATE users SET public_profile = ? WHERE id = ?').run(enabled ? 1 : 0, userId);
  return { public: Boolean(enabled) };
}

module.exports = { topTraders, publicProfile, setPublicProfile };
