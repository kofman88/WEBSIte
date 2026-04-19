/**
 * slVerifier — periodic safety check for open live trades.
 *
 * Every run:
 *   1. Fetch all trades with status='open' AND trading_mode='live'
 *   2. For each trade, parse exchange_order_ids.sl
 *   3. Call client.fetchOrder(sl_id) — if missing/cancelled/filled,
 *      we've lost our stop. Log to audit_log + emit alert.
 *
 * In a full live environment this would also emergency-close the position
 * when an SL gap is detected, but that requires a verified testnet
 * integration — see phase_14_report for the rollout plan.
 */

const db = require('../models/database');
const logger = require('../utils/logger');

/**
 * Resolve a ccxt client for a given trade. Default implementation uses
 * exchangeService.getCcxtClient; tests can pass a custom resolver.
 */
function defaultClientResolver(trade) {
  const exchangeService = require('./exchangeService');
  if (!trade.bot_id) return null;
  const bot = db.prepare('SELECT exchange_key_id FROM trading_bots WHERE id = ?').get(trade.bot_id);
  if (!bot || !bot.exchange_key_id) return null;
  return exchangeService.getCcxtClient(trade.user_id, bot.exchange_key_id);
}

async function verifyOpenTrades({ clientResolver = defaultClientResolver } = {}) {
  const trades = db.prepare(`
    SELECT id, user_id, bot_id, exchange, symbol, exchange_order_ids
    FROM trades
    WHERE status = 'open' AND trading_mode = 'live'
  `).all();

  const report = { checked: 0, ok: 0, missing: 0, errors: 0, tradeIds: { ok: [], missing: [], errors: [] } };

  for (const t of trades) {
    report.checked++;
    let ids = {};
    try { ids = JSON.parse(t.exchange_order_ids || '{}'); } catch (_e) { ids = {}; }
    const slId = ids.sl || ids.stopLoss;

    if (!slId) {
      report.missing++; report.tradeIds.missing.push(t.id);
      _flagMissing(t, 'no_sl_id_stored', null);
      continue;
    }

    let client = null;
    try { client = await clientResolver(t); } catch (e) {
      report.errors++; report.tradeIds.errors.push(t.id);
      logger.warn('slVerifier client resolve failed', { tradeId: t.id, err: e.message });
      continue;
    }
    if (!client || typeof client.fetchOrder !== 'function') {
      report.errors++; report.tradeIds.errors.push(t.id);
      logger.warn('slVerifier no fetchOrder client for trade', { tradeId: t.id });
      continue;
    }

    try {
      const order = await client.fetchOrder(slId, t.symbol);
      const status = order && order.status;
      // A healthy SL has status 'open' (ccxt normalised) or similar.
      if (!order || status === 'canceled' || status === 'closed' || status === 'expired' || status === 'rejected') {
        report.missing++; report.tradeIds.missing.push(t.id);
        _flagMissing(t, 'sl_' + (status || 'not_found'), slId);
      } else {
        report.ok++; report.tradeIds.ok.push(t.id);
      }
    } catch (err) {
      report.errors++; report.tradeIds.errors.push(t.id);
      logger.warn('slVerifier fetchOrder threw', { tradeId: t.id, err: err.message });
    }
  }

  if (report.missing > 0 || report.errors > 0) {
    logger.error('slVerifier detected issues', { report });
  } else if (report.checked > 0) {
    logger.info('slVerifier ok', { checked: report.checked });
  }

  return report;
}

function _flagMissing(trade, reason, slOrderId) {
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'sl_verifier.missing', 'trade', ?, ?)
  `).run(trade.user_id, trade.id, JSON.stringify({ reason, slOrderId, symbol: trade.symbol, exchange: trade.exchange }));
  logger.error('LIVE trade missing SL', { tradeId: trade.id, reason, slOrderId });
}

// ── cron wrapper ───────────────────────────────────────────────────────
let timer = null;
function start({ intervalMs = 5 * 60_000 } = {}) {
  if (timer) return;
  timer = setInterval(() => {
    verifyOpenTrades().catch((err) => logger.error('slVerifier cron failed', { err: err.message }));
  }, intervalMs);
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { verifyOpenTrades, start, stop };
