/**
 * partialTP.js — Partial Take Profit Manager
 * Ported from Python CHM_BREAKER_V4/partial_tp.py
 *
 * Splits position exit across 2-3 levels:
 * - TP1: 40% of qty at 1.0R
 * - TP2: 30% of qty at 1.5R
 * - Remaining 30%: final TP or trailing stop
 *
 * Handles per-exchange qty rounding and MIN_NOTIONAL validation.
 */

const config = require('../config/tradingDefaults');
const log = require('../utils/logger')('PartialTP');

/**
 * Calculate partial TP levels for a trade
 *
 * @param {object} trade - { entry, sl, direction, qty, symbol, leverage }
 * @param {object} opts  - Override defaults from config.PARTIAL_TP
 * @returns {object} { legs: [{price, qty, label}], totalQty, riskPerUnit }
 */
function calculatePartialTP(trade, opts = {}) {
  const cfg = { ...config.PARTIAL_TP, ...opts };
  if (!cfg.enabled) return null;

  const entry = parseFloat(trade.entry);
  const sl    = parseFloat(trade.sl);
  const qty   = parseFloat(trade.qty);
  const dir   = (trade.direction || 'long').toLowerCase();

  if (!entry || !sl || !qty || entry <= 0) return null;

  const riskPerUnit = Math.abs(entry - sl);
  if (riskPerUnit <= 0) return null;

  // Calculate TP prices from R multiples
  const tp1Price = dir === 'long'
    ? entry + riskPerUnit * cfg.tp1R
    : entry - riskPerUnit * cfg.tp1R;
  const tp2Price = dir === 'long'
    ? entry + riskPerUnit * cfg.tp2R
    : entry - riskPerUnit * cfg.tp2R;

  // Split qty — TP2 and TP3 first (rounded down), TP1 gets remainder
  const exchangeInfo = _getExchangeInfo(trade.symbol);
  const tp2Qty = _roundQty(qty * cfg.tp2Pct, exchangeInfo);
  // Check if tp2Qty meets min notional
  const tp2Notional = tp2Qty * tp2Price;
  let actualTp2Qty = tp2Notional >= cfg.minNotional ? tp2Qty : 0;

  // TP1 gets the rest (after TP2)
  const tp1Qty = _roundQty(qty - actualTp2Qty, exchangeInfo);

  const legs = [];

  if (actualTp2Qty > 0) {
    // TP1 = partial close
    const tp1PartialQty = _roundQty(qty * cfg.tp1Pct, exchangeInfo);
    const tp1Remainder = _roundQty(qty - tp1PartialQty - actualTp2Qty, exchangeInfo);

    legs.push({ price: tp1Price, qty: tp1PartialQty, label: 'TP1', rMultiple: cfg.tp1R });
    legs.push({ price: tp2Price, qty: actualTp2Qty, label: 'TP2', rMultiple: cfg.tp2R });
    if (tp1Remainder > 0) {
      legs.push({ price: null, qty: tp1Remainder, label: 'TRAILING', rMultiple: null });
    }
  } else {
    // TP2 too small — single TP1 exit
    legs.push({ price: tp1Price, qty: qty, label: 'TP1', rMultiple: cfg.tp1R });
  }

  // Verify total qty matches
  const totalLegQty = legs.reduce((s, l) => s + l.qty, 0);
  if (Math.abs(totalLegQty - qty) > exchangeInfo.qtyStep) {
    // Fix rounding — add difference to first leg
    legs[0].qty = _roundQty(legs[0].qty + (qty - totalLegQty), exchangeInfo);
  }

  return {
    legs,
    totalQty: qty,
    riskPerUnit,
    entry,
    sl,
    direction: dir,
  };
}

/**
 * Calculate partial TP specifically for scalping strategy
 * TP1 25% at 1.5R, TP2 25% at 2.0R, rest 50% trailing
 */
function calculateScalpingTP(trade) {
  return calculatePartialTP(trade, {
    enabled: true,
    tp1Pct: 0.25,
    tp2Pct: 0.25,
    tp1R:   1.5,
    tp2R:   2.0,
    minNotional: 5.0,
  });
}

// ── Qty rounding ────────────────────────────────────────────────────────────

function _roundQty(qty, info) {
  const step = info.qtyStep || 0.001;
  return Math.floor(qty / step) * step;
}

function _getExchangeInfo(symbol) {
  // Default exchange info — in production, fetch from exchange API
  const sym = (symbol || '').toUpperCase();
  if (sym.startsWith('BTC')) return { qtyStep: 0.001, minNotional: 5 };
  if (sym.startsWith('ETH')) return { qtyStep: 0.01,  minNotional: 5 };
  if (sym.startsWith('SOL')) return { qtyStep: 0.1,   minNotional: 5 };
  if (sym.startsWith('XRP')) return { qtyStep: 1,     minNotional: 5 };
  if (sym.startsWith('DOGE'))return { qtyStep: 1,     minNotional: 5 };
  return { qtyStep: 0.01, minNotional: 5 };
}

module.exports = { calculatePartialTP, calculateScalpingTP };
