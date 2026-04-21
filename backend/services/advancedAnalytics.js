/**
 * Advanced analytics — the metrics professional traders want to see but
 * weren't in v1 (max drawdown, Sharpe, profit factor, streaks, best/worst,
 * R-multiple distribution, hourly/daily heatmaps, open positions live,
 * risk exposure, leaderboard percentile).
 *
 * All computations are pure JS on top of trades table rows — no external
 * dependencies, no pre-computed snapshots yet. If volume grows we'll add a
 * materialised view or hourly snapshots, but for <100k trades per user
 * this is fast enough.
 */

const db = require('../models/database');

function _closedTrades(userId, { days = null } = {}) {
  const params = [userId];
  let sql = `
    SELECT id, symbol, side, strategy, entry_price, exit_price,
           realized_pnl, realized_pnl_pct, opened_at, closed_at,
           stop_loss, take_profit_1
    FROM trades
    WHERE user_id = ? AND status = 'closed' AND realized_pnl IS NOT NULL
  `;
  if (days) { sql += ' AND closed_at >= ?'; params.push(new Date(Date.now() - days * 86_400_000).toISOString()); }
  sql += ' ORDER BY closed_at ASC';
  return db.prepare(sql).all(...params);
}

/** Max drawdown % of starting balance + peak-to-trough equity delta. */
function maxDrawdown(trades, startingBalance = 10000) {
  let equity = startingBalance;
  let peak = equity;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const t of trades) {
    equity += Number(t.realized_pnl) || 0;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) { maxDd = dd; maxDdPct = peak > 0 ? (dd / peak) * 100 : 0; }
  }
  return { maxDdUsd: Math.round(maxDd * 100) / 100, maxDdPct: Math.round(maxDdPct * 100) / 100 };
}

/** Sharpe ratio — annualised on daily mean/stdev of trade returns. */
function sharpe(trades) {
  if (trades.length < 5) return null;
  const returns = trades.map((t) => Number(t.realized_pnl_pct) || 0);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  // Rough scaling — treat each trade as one sample, annualise ×sqrt(252)
  return Math.round((mean / sd) * Math.sqrt(252) * 100) / 100;
}

/** Profit factor = gross wins / |gross losses|. >1.5 rule of thumb. */
function profitFactor(trades) {
  let wins = 0; let losses = 0;
  for (const t of trades) {
    const p = Number(t.realized_pnl) || 0;
    if (p > 0) wins += p;
    else if (p < 0) losses += Math.abs(p);
  }
  if (losses === 0) return wins > 0 ? Infinity : 0;
  return Math.round((wins / losses) * 100) / 100;
}

/** Current streak: positive = N wins in a row, negative = N losses. */
function currentStreak(trades) {
  if (!trades.length) return { streak: 0, type: 'none' };
  const last = Number(trades[trades.length - 1].realized_pnl);
  const winStreak = last > 0;
  let n = 0;
  for (let i = trades.length - 1; i >= 0; i -= 1) {
    const p = Number(trades[i].realized_pnl) || 0;
    if ((winStreak && p > 0) || (!winStreak && p < 0)) n += 1;
    else break;
  }
  return { streak: n, type: winStreak ? 'win' : 'loss' };
}

/** Best / worst single trade. */
function bestWorst(trades) {
  if (!trades.length) return { best: null, worst: null };
  let best = trades[0]; let worst = trades[0];
  for (const t of trades) {
    if ((Number(t.realized_pnl) || 0) > (Number(best.realized_pnl) || 0)) best = t;
    if ((Number(t.realized_pnl) || 0) < (Number(worst.realized_pnl) || 0)) worst = t;
  }
  return {
    best:  { symbol: best.symbol,  pnlUsd: Number(best.realized_pnl),  pnlPct: Number(best.realized_pnl_pct),  closedAt: best.closed_at  },
    worst: { symbol: worst.symbol, pnlUsd: Number(worst.realized_pnl), pnlPct: Number(worst.realized_pnl_pct), closedAt: worst.closed_at },
  };
}

/**
 * R-multiple distribution — expresses each trade's PnL as a multiple of
 * its original risk (SL distance × quantity). Bucketed into -3R / -2R /
 * -1R / 0R / +1R / +2R / +3R / +3R+.
 */
function rMultiples(trades) {
  const buckets = { '-3R+': 0, '-2R': 0, '-1R': 0, '0R': 0, '+1R': 0, '+2R': 0, '+3R': 0, '+3R+': 0 };
  for (const t of trades) {
    const entry = Number(t.entry_price); const sl = Number(t.stop_loss);
    const pnl = Number(t.realized_pnl) || 0;
    if (!entry || !sl || entry === sl) continue;
    const riskUsd = Math.abs(entry - sl) / entry * 100; // we don't have qty here, use pnl_pct instead
    const r = Number(t.realized_pnl_pct) / (riskUsd || 1);
    const rounded = Math.round(r);
    if (rounded <= -3) buckets['-3R+'] += 1;
    else if (rounded === -2) buckets['-2R'] += 1;
    else if (rounded === -1) buckets['-1R'] += 1;
    else if (rounded === 0) buckets['0R'] += 1;
    else if (rounded === 1) buckets['+1R'] += 1;
    else if (rounded === 2) buckets['+2R'] += 1;
    else if (rounded === 3) buckets['+3R'] += 1;
    else buckets['+3R+'] += 1;
    // Fallback for zero-risk trades: only count by pnl sign
    if (!sl) {
      if (pnl > 0) buckets['+1R'] += 1; else if (pnl < 0) buckets['-1R'] += 1;
    }
  }
  return buckets;
}

/** Calendar-grid P&L per day for last N days (default 180 = half-year). */
function calendarPnl(userId, { days = 180 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT DATE(closed_at) AS day, COALESCE(SUM(realized_pnl), 0) AS pnl, COUNT(*) AS n
    FROM trades WHERE user_id = ? AND status = 'closed' AND closed_at >= ?
    GROUP BY DATE(closed_at)
  `).all(userId, since);
  const byDay = {};
  for (const r of rows) byDay[r.day] = { pnl: Number(r.pnl), trades: r.n };
  // Fill missing days so the grid is continuous
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day: d, pnl: (byDay[d] && byDay[d].pnl) || 0, trades: (byDay[d] && byDay[d].trades) || 0 });
  }
  return out;
}

/** Hour-of-day P&L distribution (0-23). */
function hourlyPnl(userId, { days = 90 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db.prepare(`
    SELECT CAST(strftime('%H', opened_at) AS INT) AS hour,
           COALESCE(SUM(realized_pnl), 0) AS pnl,
           COUNT(*) AS n,
           SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins
    FROM trades WHERE user_id = ? AND status = 'closed' AND opened_at >= ?
    GROUP BY hour
  `).all(userId, since);
  const byHour = {};
  for (let h = 0; h < 24; h += 1) byHour[h] = { hour: h, pnl: 0, trades: 0, wins: 0, winRate: null };
  for (const r of rows) {
    byHour[r.hour] = {
      hour: r.hour, pnl: Number(r.pnl), trades: r.n, wins: r.wins,
      winRate: r.n ? r.wins / r.n : null,
    };
  }
  return Object.values(byHour);
}

/** Open positions with their unrealized PnL (using last available price). */
function openPositions(userId) {
  return db.prepare(`
    SELECT t.id, t.symbol, t.side, t.strategy, t.entry_price, t.quantity,
           t.stop_loss, t.take_profit_1, t.leverage,
           t.opened_at, t.trading_mode, t.bot_id,
           b.name AS bot_name
    FROM trades t LEFT JOIN trading_bots b ON b.id = t.bot_id
    WHERE t.user_id = ? AND t.status = 'open'
    ORDER BY t.opened_at DESC
  `).all(userId).map((r) => ({
    id: r.id, symbol: r.symbol, side: r.side, strategy: r.strategy,
    entryPrice: Number(r.entry_price), quantity: Number(r.quantity),
    stopLoss: r.stop_loss != null ? Number(r.stop_loss) : null,
    takeProfit: r.take_profit_1 != null ? Number(r.take_profit_1) : null,
    leverage: Number(r.leverage) || 1,
    openedAt: r.opened_at, tradingMode: r.trading_mode, botId: r.bot_id, botName: r.bot_name,
    riskUsd: r.stop_loss != null ? Math.abs(Number(r.entry_price) - Number(r.stop_loss)) * Number(r.quantity) : null,
  }));
}

/** Total risk currently at-play in open positions (sum of |entry-SL| × qty). */
function riskExposure(userId) {
  const rows = db.prepare(`
    SELECT entry_price, stop_loss, quantity
    FROM trades WHERE user_id = ? AND status = 'open' AND stop_loss IS NOT NULL
  `).all(userId);
  let total = 0;
  for (const r of rows) total += Math.abs(Number(r.entry_price) - Number(r.stop_loss)) * Number(r.quantity);
  return Math.round(total * 100) / 100;
}

/** Bot leaderboard — each user's bots ranked by last-30d PnL. */
function botLeaderboard(userId, { days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return db.prepare(`
    SELECT b.id, b.name, b.strategy, b.is_active, b.trading_mode,
           COUNT(t.id) AS trades,
           COALESCE(SUM(t.realized_pnl), 0) AS pnl,
           SUM(CASE WHEN t.realized_pnl > 0 THEN 1 ELSE 0 END) AS wins
    FROM trading_bots b
    LEFT JOIN trades t ON t.bot_id = b.id AND t.status = 'closed' AND t.closed_at >= ?
    WHERE b.user_id = ?
    GROUP BY b.id
    ORDER BY pnl DESC
  `).all(since, userId).map((r) => ({
    id: r.id, name: r.name, strategy: r.strategy,
    isActive: Boolean(r.is_active), mode: r.trading_mode,
    trades: r.trades || 0, pnl: Number(r.pnl) || 0,
    winRate: r.trades ? r.wins / r.trades : null,
  }));
}

/** BTC buy-and-hold benchmark for equity-curve comparison. */
function btcBenchmark({ days = 90 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db.prepare(`
    SELECT DATE(open_time / 1000, 'unixepoch') AS day,
           (SELECT close_price FROM candles_cache c2
              WHERE c2.exchange = 'bybit' AND c2.symbol = 'BTC/USDT' AND c2.timeframe = '1d'
                AND DATE(c2.open_time / 1000, 'unixepoch') = DATE(c1.open_time / 1000, 'unixepoch')
              ORDER BY c2.open_time DESC LIMIT 1) AS close
    FROM candles_cache c1
    WHERE c1.exchange = 'bybit' AND c1.symbol = 'BTC/USDT' AND c1.timeframe = '1d'
      AND c1.open_time >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(new Date(since).getTime());
  return rows.map((r) => ({ day: r.day, close: Number(r.close) }));
}

/** User's percentile in the leaderboard (0-100, higher is better). */
function leaderboardPercentile(userId, { period = '30d' } = {}) {
  const days = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[period] || 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const allPnls = db.prepare(`
    SELECT user_id, COALESCE(SUM(realized_pnl), 0) AS pnl
    FROM trades
    WHERE status = 'closed' AND closed_at >= ?
    GROUP BY user_id
    HAVING COUNT(*) >= 3
  `).all(since);
  if (allPnls.length < 2) return null;
  const sorted = allPnls.map((r) => Number(r.pnl)).sort((a, b) => a - b);
  const myRow = allPnls.find((r) => r.user_id === userId);
  if (!myRow) return null;
  const myPnl = Number(myRow.pnl);
  const rank = sorted.filter((p) => p <= myPnl).length;
  return Math.round((rank / sorted.length) * 100);
}

/** Single aggregate call to load everything the dashboard v2 needs. */
function dashboardStats(userId) {
  const closed = _closedTrades(userId);
  const closed30 = _closedTrades(userId, { days: 30 });
  const { maxDdUsd, maxDdPct } = maxDrawdown(closed);
  return {
    totals: {
      closedTrades: closed.length,
      totalPnl: closed.reduce((s, t) => s + (Number(t.realized_pnl) || 0), 0),
      wins: closed.filter((t) => Number(t.realized_pnl) > 0).length,
      losses: closed.filter((t) => Number(t.realized_pnl) < 0).length,
    },
    metrics: {
      maxDdUsd, maxDdPct,
      sharpe: sharpe(closed),
      profitFactor: profitFactor(closed),
      last30Pnl: closed30.reduce((s, t) => s + (Number(t.realized_pnl) || 0), 0),
    },
    streak: currentStreak(closed),
    bestWorst: bestWorst(closed),
    rMultiples: rMultiples(closed),
    openPositions: openPositions(userId),
    riskExposure: riskExposure(userId),
    botLeaderboard: botLeaderboard(userId),
  };
}

module.exports = {
  maxDrawdown, sharpe, profitFactor, currentStreak, bestWorst, rMultiples,
  calendarPnl, hourlyPnl, openPositions, riskExposure, botLeaderboard,
  btcBenchmark, leaderboardPercentile, dashboardStats,
};
