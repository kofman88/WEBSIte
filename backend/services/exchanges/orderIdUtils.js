'use strict';
/**
 * orderIdUtils.js — one-to-one port of `order_id_utils.py` (Stage 3A-2).
 *
 * Deterministic client order id shared by all exchanges:
 *   "chm_" + sha256(f"{trade_id}:{user_id}:{exchange}:{order_type}:{attempt}").hexdigest()[:12]
 * (16 chars — fits Bybit orderLinkId 36, BingX clientOrderId 40, Binance newClientOrderId 36).
 * The same trade/user/type always yields the same id, so a retried placement is rejected
 * by the exchange as a duplicate (Bybit 110072, BingX 101204/101404, Binance -4015) and the
 * trader treats that as success.
 */

const crypto = require('crypto');

const ORDER_TYPES = Object.freeze(['entry', 'sl', 'tp1', 'tp2', 'tp3', 'be_move']);

/** f"{x}" of the Python arguments: ints print as ints, strings as-is. */
function fmtPart(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

function computeClientOrderId(tradeId, userId, exchange, orderType, attempt = 1) {
  const key = `${fmtPart(tradeId)}:${fmtPart(userId)}:${fmtPart(exchange)}:${fmtPart(orderType)}:${fmtPart(attempt)}`;
  const digest = crypto.createHash('sha256').update(Buffer.from(key, 'utf8')).digest('hex').slice(0, 12);
  return `chm_${digest}`;
}

module.exports = { ORDER_TYPES, computeClientOrderId };
