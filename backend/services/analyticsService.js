/**
 * Analytics — P&L breakdowns + CSV export streaming.
 *
 * Read-only service. All queries go against the trades table (closed trades
 * only for P&L — open trades contribute 0 since realized_pnl=0 until close).
 */

const db = require('../models/database');

function _dateRangeClause(q) {
  const parts = [];
  const params = [];
  if (q.from) { parts.push('opened_at >= ?'); params.push(q.from); }
  if (q.to)   { parts.push('opened_at <= ?'); params.push(q.to); }
  return { where: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
}

function totals(userId, q = {}) {
  const dr = _dateRangeClause(q);
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_trades,
      COALESCE(SUM(CASE WHEN status='closed' THEN realized_pnl END), 0) AS total_pnl,
      COALESCE(SUM(CASE WHEN status='closed' AND realized_pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
      COALESCE(SUM(CASE WHEN status='closed' AND realized_pnl < 0 THEN 1 ELSE 0 END), 0) AS losses,
      COALESCE(SUM(CASE WHEN status='closed' AND realized_pnl > 0 THEN realized_pnl ELSE 0 END), 0) AS gross_profit,
      COALESCE(SUM(CASE WHEN status='closed' AND realized_pnl < 0 THEN -realized_pnl ELSE 0 END), 0) AS gross_loss,
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open_trades
    FROM trades WHERE user_id = ? ${dr.where}
  `).get(userId, ...dr.params);

  const closed = (row.wins || 0) + (row.losses || 0);
  return {
    totalTrades: row.total_trades || 0,
    closedTrades: closed,
    openTrades: row.open_trades || 0,
    totalPnl: Number(row.total_pnl) || 0,
    wins: row.wins || 0,
    losses: row.losses || 0,
    winRate: closed ? row.wins / closed : null,
    profitFactor: row.gross_loss > 0 ? row.gross_profit / row.gross_loss : (row.gross_profit > 0 ? Infinity : 0),
    grossProfit: Number(row.gross_profit) || 0,
    grossLoss: Number(row.gross_loss) || 0,
  };
}

function bySymbol(userId, q = {}) {
  const dr = _dateRangeClause(q);
  return db.prepare(`
    SELECT symbol,
      COUNT(*) AS trades,
      COALESCE(SUM(CASE WHEN status='closed' THEN realized_pnl END), 0) AS pnl,
      SUM(CASE WHEN status='closed' AND realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN status='closed' AND realized_pnl < 0 THEN 1 ELSE 0 END) AS losses
    FROM trades WHERE user_id = ? ${dr.where}
    GROUP BY symbol ORDER BY pnl DESC
  `).all(userId, ...dr.params).map(_hydrate);
}

function byStrategy(userId, q = {}) {
  const dr = _dateRangeClause(q);
  return db.prepare(`
    SELECT COALESCE(strategy, 'unknown') AS strategy,
      COUNT(*) AS trades,
      COALESCE(SUM(CASE WHEN status='closed' THEN realized_pnl END), 0) AS pnl,
      SUM(CASE WHEN status='closed' AND realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN status='closed' AND realized_pnl < 0 THEN 1 ELSE 0 END) AS losses
    FROM trades WHERE user_id = ? ${dr.where}
    GROUP BY strategy ORDER BY pnl DESC
  `).all(userId, ...dr.params).map(_hydrate);
}

function byMonth(userId, q = {}) {
  const dr = _dateRangeClause(q);
  return db.prepare(`
    SELECT strftime('%Y-%m', opened_at) AS month,
      COUNT(*) AS trades,
      COALESCE(SUM(CASE WHEN status='closed' THEN realized_pnl END), 0) AS pnl,
      SUM(CASE WHEN status='closed' AND realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN status='closed' AND realized_pnl < 0 THEN 1 ELSE 0 END) AS losses
    FROM trades WHERE user_id = ? ${dr.where}
    GROUP BY month ORDER BY month ASC
  `).all(userId, ...dr.params).map(_hydrate);
}

function equityCurve(userId, { days = 90 } = {}) {
  // Cumulative closed-P&L timeline grouped by day
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const daily = db.prepare(`
    SELECT strftime('%Y-%m-%d', closed_at) AS day,
      SUM(realized_pnl) AS pnl
    FROM trades
    WHERE user_id = ? AND status = 'closed' AND closed_at >= ?
    GROUP BY day ORDER BY day ASC
  `).all(userId, since);
  let cum = 0;
  return daily.map((r) => { cum += Number(r.pnl) || 0; return { day: r.day, dailyPnl: Number(r.pnl) || 0, equity: Math.round(cum * 100) / 100 }; });
}

function _hydrate(r) {
  const closed = (r.wins || 0) + (r.losses || 0);
  return {
    ...r,
    pnl: Number(r.pnl) || 0,
    winRate: closed ? r.wins / closed : null,
  };
}

// ── CSV export ──────────────────────────────────────────────────────────
function csvStream(userId, res, q = {}) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="trades-' + Date.now() + '.csv"');
  // BOM for Excel UTF-8 compatibility
  res.write('\uFEFF');
  res.write([
    'ID', 'Opened At', 'Closed At', 'Exchange', 'Symbol', 'Side', 'Strategy',
    'Entry', 'Exit', 'Quantity', 'Leverage', 'SL', 'TP1', 'TP2', 'TP3',
    'Status', 'Close Reason', 'Realized PnL', 'Realized PnL %', 'Mode', 'Note',
  ].join(',') + '\n');

  const dr = _dateRangeClause(q);
  // Stream in batches so a 100K-row export doesn't blow memory
  const LIMIT = 500;
  let offset = 0;
  /* eslint-disable no-constant-condition */
  while (true) {
    const rows = db.prepare(`
      SELECT id, opened_at, closed_at, exchange, symbol, side, strategy,
             entry_price, exit_price, quantity, leverage, stop_loss,
             take_profit_1, take_profit_2, take_profit_3,
             status, close_reason, realized_pnl, realized_pnl_pct, trading_mode, note
      FROM trades WHERE user_id = ? ${dr.where}
      ORDER BY opened_at DESC LIMIT ? OFFSET ?
    `).all(userId, ...dr.params, LIMIT, offset);
    if (!rows.length) break;
    for (const r of rows) {
      res.write([
        r.id, _csv(r.opened_at), _csv(r.closed_at), _csv(r.exchange), _csv(r.symbol), _csv(r.side), _csv(r.strategy),
        r.entry_price ?? '', r.exit_price ?? '', r.quantity ?? '', r.leverage ?? '',
        r.stop_loss ?? '', r.take_profit_1 ?? '', r.take_profit_2 ?? '', r.take_profit_3 ?? '',
        _csv(r.status), _csv(r.close_reason), r.realized_pnl ?? '', r.realized_pnl_pct ?? '',
        _csv(r.trading_mode), _csv(r.note),
      ].join(',') + '\n');
    }
    if (rows.length < LIMIT) break;
    offset += LIMIT;
  }
  res.end();
}

function _csv(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ── Trade journal (notes) ────────────────────────────────────────────
function setNote(userId, tradeId, note) {
  const info = db.prepare(`UPDATE trades SET note = ? WHERE id = ? AND user_id = ?`)
    .run(note === '' ? null : note, tradeId, userId);
  if (info.changes === 0) { const e = new Error('Trade not found'); e.statusCode = 404; throw e; }
  return { updated: 1 };
}

module.exports = {
  totals, bySymbol, byStrategy, byMonth, equityCurve,
  csvStream, setNote,
};
