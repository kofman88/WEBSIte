/**
 * Partial TP manager — watches open trades and fills TPs/SL as price reaches
 * them. Runs on a cron (every 60s).
 *
 * Rules (long — mirrored for short):
 *   bar.high >= TP1 & !tp1Hit → close 33%, move SL to entry (BE)
 *   bar.high >= TP2 & !tp2Hit → close 33%, trail SL to TP1
 *   bar.high >= TP3           → close remainder
 *   bar.low  <= SL            → close remainder (close_reason = sl | trailing_sl)
 *
 * Same-bar SL+TP conflict: SL wins (conservative).
 *
 * Paper mode: uses fetchCandles for latest close price + simulates fills.
 * Live mode: relies on exchange to fire TP/SL orders; this manager
 * synchronises state by fetching order statuses.
 */

const db = require('../models/database');
const logger = require('../utils/logger');

const PARTIAL_FRACTIONS = { tp1: 0.33, tp2: 0.33, tp3: 0.34 };

let marketDataRef = null;
let exchangeServiceRef = null;

function init({ marketData, exchangeService } = {}) {
  marketDataRef = marketData || null;
  exchangeServiceRef = exchangeService || null;
}

async function tickOpen() {
  const trades = db.prepare(`SELECT * FROM trades WHERE status = 'open'`).all();
  if (!trades.length) return { processed: 0, closed: 0 };
  let closed = 0;
  for (const t of trades) {
    try {
      const didClose = await _processOne(t);
      if (didClose) closed++;
    } catch (err) {
      logger.warn('partialTp tick error', { tradeId: t.id, err: err.message });
    }
  }
  return { processed: trades.length, closed };
}

async function _processOne(trade) {
  if (trade.trading_mode === 'paper') {
    return _processPaper(trade);
  } else if (trade.trading_mode === 'live') {
    return _processLive(trade);
  }
  return false;
}

function _loadFillsState(tradeId) {
  const fills = db.prepare(`
    SELECT event_type, quantity FROM trade_fills WHERE trade_id = ?
  `).all(tradeId);
  const state = { tp1Hit: false, tp2Hit: false, tp3Hit: false, slHit: false, remainingQty: 0 };
  let totalExit = 0;
  for (const f of fills) {
    if (f.event_type === 'tp1') state.tp1Hit = true;
    if (f.event_type === 'tp2') state.tp2Hit = true;
    if (f.event_type === 'tp3') state.tp3Hit = true;
    if (f.event_type === 'sl' || f.event_type === 'trailing_sl') state.slHit = true;
    if (f.event_type !== 'entry') totalExit += Number(f.quantity) || 0;
  }
  return { state, totalExit };
}

async function _processPaper(trade) {
  if (!marketDataRef) return false;
  let candles;
  try {
    candles = await marketDataRef.fetchCandles(trade.exchange, trade.symbol, trade.timeframe, { limit: 5 });
  } catch (err) {
    logger.debug('partialTp: fetchCandles failed', { tradeId: trade.id, err: err.message });
    return false;
  }
  if (!candles || !candles.length) return false;

  const entryTime = new Date(trade.opened_at).getTime();
  const fresh = candles.filter((c) => c[0] > entryTime);
  if (!fresh.length) return false;

  const { state, totalExit } = _loadFillsState(trade.id);
  let slPrice = trade.stop_loss;
  let remaining = trade.quantity - totalExit;
  if (remaining <= 1e-10) {
    _finalizeIfExits(trade, remaining);
    return true;
  }

  for (const bar of fresh) {
    const [barTime, , high, low] = bar;
    const slHitNow = trade.side === 'long' ? low <= slPrice : high >= slPrice;
    const tp1 = trade.take_profit_1, tp2 = trade.take_profit_2, tp3 = trade.take_profit_3;

    if (slHitNow) {
      const qty = remaining;
      const reason = state.tp1Hit || state.tp2Hit ? 'trailing_sl' : 'sl';
      _recordFill(trade, reason, slPrice, qty, barTime);
      remaining = 0;
      _closeTrade(trade, slPrice, reason, barTime);
      return true;
    }

    // Long TP progression
    if (trade.side === 'long') {
      if (!state.tp1Hit && tp1 && high >= tp1) {
        const qty = trade.quantity * PARTIAL_FRACTIONS.tp1;
        _recordFill(trade, 'tp1', tp1, qty, barTime);
        state.tp1Hit = true; remaining -= qty;
        slPrice = trade.entry_price; // BE
        db.prepare(`UPDATE trades SET stop_loss = ? WHERE id = ?`).run(slPrice, trade.id);
      }
      if (!state.tp2Hit && tp2 && high >= tp2) {
        const qty = trade.quantity * PARTIAL_FRACTIONS.tp2;
        _recordFill(trade, 'tp2', tp2, qty, barTime);
        state.tp2Hit = true; remaining -= qty;
        slPrice = tp1; // trail
        db.prepare(`UPDATE trades SET stop_loss = ? WHERE id = ?`).run(slPrice, trade.id);
      }
      if (!state.tp3Hit && tp3 && high >= tp3) {
        const qty = remaining;
        _recordFill(trade, 'tp3', tp3, qty, barTime);
        remaining = 0;
        _closeTrade(trade, tp3, 'tp3', barTime);
        return true;
      }
    } else {
      // Short mirrored
      if (!state.tp1Hit && tp1 && low <= tp1) {
        const qty = trade.quantity * PARTIAL_FRACTIONS.tp1;
        _recordFill(trade, 'tp1', tp1, qty, barTime);
        state.tp1Hit = true; remaining -= qty;
        slPrice = trade.entry_price;
        db.prepare(`UPDATE trades SET stop_loss = ? WHERE id = ?`).run(slPrice, trade.id);
      }
      if (!state.tp2Hit && tp2 && low <= tp2) {
        const qty = trade.quantity * PARTIAL_FRACTIONS.tp2;
        _recordFill(trade, 'tp2', tp2, qty, barTime);
        state.tp2Hit = true; remaining -= qty;
        slPrice = tp1;
        db.prepare(`UPDATE trades SET stop_loss = ? WHERE id = ?`).run(slPrice, trade.id);
      }
      if (!state.tp3Hit && tp3 && low <= tp3) {
        const qty = remaining;
        _recordFill(trade, 'tp3', tp3, qty, barTime);
        remaining = 0;
        _closeTrade(trade, tp3, 'tp3', barTime);
        return true;
      }
    }
  }
  return false;
}

async function _processLive(trade) {
  if (!exchangeServiceRef || !trade.exchange_order_ids) return false;
  // In live mode, SL/TP orders are placed on exchange side.
  // We only need to check their statuses and sync `trades` + `trade_fills`.
  // Real implementation would: fetch orders via ccxt.fetchOrder, match to
  // exchange_order_ids, and on any `filled` status → insert trade_fills
  // + possibly adjust SL order via client.editOrder.
  //
  // For Phase 10 MVP: poll is best-effort; if a TP fired we record it,
  // but we do NOT edit the on-exchange SL here (that's slVerifier's job).
  try {
    const client = exchangeServiceRef.getCcxtClient(null, trade.user_id);
    // CCXT fetchOrder requires symbol + id. We skip if client.fetchOrder missing.
    if (!client.fetchOrder) return false;
    // Stub — returning false to avoid accidentally double-counting without
    // a proper reconciliation algorithm. Full logic deferred to Phase 14.
    return false;
  } catch (err) {
    logger.debug('live partialTp check failed', { tradeId: trade.id, err: err.message });
    return false;
  }
}

function _recordFill(trade, eventType, price, qty, ts) {
  const pnlGross = (trade.side === 'long' ? price - trade.entry_price : trade.entry_price - price) * qty;
  // Paper fees: 0.05% + 0.02% slippage
  const fee = qty * price * 0.0007;
  const pnl = pnlGross - fee;
  db.prepare(`
    INSERT INTO trade_fills (trade_id, event_type, price, quantity, pnl, executed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(trade.id, eventType, price, qty, pnl, new Date(ts).toISOString());
  logger.info('partial fill', {
    tradeId: trade.id, event: eventType, price: round(price), qty: round(qty), pnl: round(pnl),
  });
}

function _closeTrade(trade, price, reason, ts) {
  const fills = db.prepare(`SELECT pnl FROM trade_fills WHERE trade_id = ? AND event_type != 'entry'`).all(trade.id);
  const totalPnl = fills.reduce((s, f) => s + (Number(f.pnl) || 0), 0);
  const pnlPct = trade.entry_price > 0 ? (totalPnl / (trade.entry_price * trade.quantity)) * 100 : 0;
  db.prepare(`
    UPDATE trades
    SET status = 'closed', exit_price = ?, close_reason = ?,
        realized_pnl = ?, realized_pnl_pct = ?, closed_at = ?
    WHERE id = ?
  `).run(price, reason, totalPnl, pnlPct, new Date(ts).toISOString(), trade.id);

  // Update paper equity for the bot
  if (trade.trading_mode === 'paper' && trade.bot_id) {
    const key = 'paper_equity:bot:' + trade.bot_id;
    const row = db.prepare('SELECT value FROM system_kv WHERE key = ?').get(key);
    const current = row ? parseFloat(row.value) : 10000;
    const newEquity = Math.max(0, current + totalPnl);
    db.prepare(`INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`)
      .run(key, String(newEquity));
  }

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'auto_trade.close', 'trade', ?, ?)
  `).run(trade.user_id, trade.id, JSON.stringify({ reason, pnl: totalPnl }));

  logger.info('trade closed', {
    tradeId: trade.id, reason, exitPrice: round(price), pnl: round(totalPnl),
  });
  try {
    const notifier = require('./notifier');
    const emoji = totalPnl > 0 ? '🟢' : totalPnl < 0 ? '🔴' : '⚪';
    const reasonLabel = reason === 'stop_loss' ? 'SL' : reason === 'take_profit' ? 'TP' : reason;
    notifier.dispatch(trade.user_id, {
      type: 'trade_closed',
      title: `${emoji} ${trade.symbol} · ${reasonLabel} · ${totalPnl >= 0 ? '+' : ''}${round(totalPnl)} USD`,
      body: `Сделка закрыта @ ${round(price)} (${(pnlPct).toFixed(2)}%)`,
      link: '/dashboard.html',
    });
  } catch (_e) {}
}

function _finalizeIfExits(trade, remaining) {
  if (remaining > 1e-10) return;
  const fills = db.prepare(`SELECT pnl FROM trade_fills WHERE trade_id = ? AND event_type != 'entry'`).all(trade.id);
  const totalPnl = fills.reduce((s, f) => s + (Number(f.pnl) || 0), 0);
  db.prepare(`
    UPDATE trades SET status = 'closed', realized_pnl = ?, closed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'open'
  `).run(totalPnl, trade.id);
}

function round(x, d = 8) { if (!Number.isFinite(x)) return x; const p = Math.pow(10, d); return Math.round(x * p) / p; }

module.exports = { init, tickOpen, _loadFillsState };
