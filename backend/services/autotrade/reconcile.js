'use strict';
/**
 * reconcile.js — auto_trade's post-timeout / post-open position checks.
 *
 *   reconcileTimeoutPosition({exchange, apiKey, apiSecret, symbol, direction, bybitDemo, okxPassphrase})
 *       L3.6C: one get_positions(symbol) (10 s); the first size>0 position on our side →
 *       {size, order_id ('reconciled_after_timeout' when the exchange gives none), side, stopLoss};
 *       any error / nothing → null. Never throws.
 *   cancelPendingAfterTimeout({...})   L3.6D: cancel_all_orders(symbol) (10 s) → cancelled count, 0 on error
 *   resolveLimitUnfilledGrace(strategy)  {SMC: 900, LEVELS: 60}, default 60
 *   limitUnfilledGuard({..., graceS})  L3.13: sleep grace → reconcile → size 0 → cancel pending +
 *       `[LIMIT-UNFILLED] …` → true (the caller notifies). Does NOT touch the DB.
 */

const { waitFor, isCancelledError } = require('./asyncio');
const { pf } = require('./pyfmt');
const { pyFloat, pyInt, pyGet, pyOr, pyStr } = require('../exchanges/pyCompat');
const { pyUpper } = require('../../strategies/common/pyUnicode');

const LIMIT_UNFILLED_GRACE_S_DEFAULT = 60;
const LIMIT_UNFILLED_GRACE_S_BY_STRATEGY = Object.freeze({ SMC: 900, LEVELS: 60 });

function resolveLimitUnfilledGrace(strategy) {
  const k = pyUpper(String(strategy || ''));
  return Object.prototype.hasOwnProperty.call(LIMIT_UNFILLED_GRACE_S_BY_STRATEGY, k) ? LIMIT_UNFILLED_GRACE_S_BY_STRATEGY[k] : LIMIT_UNFILLED_GRACE_S_DEFAULT;
}

function createReconcile({ traderFor, log = null, sleep = null, timers = undefined } = {}) {
  const logger = log || require('../marketData/mdLog').log;
  const asleep = sleep || ((s) => new Promise((r) => setTimeout(r, s * 1000)));
  // asyncio.wait_for around one trader call. A Bybit pybit call is `await loop.run_in_executor(...)`
  // inside the trader (rt.runInThread): the timeout cancels the coroutine at that await, the thread runs on.
  const call = (_exchange, _fn, timeoutS, thunk) => waitFor(thunk, timeoutS, { timers });

  async function reconcileTimeoutPosition({ exchange, apiKey, apiSecret, symbol, direction, bybitDemo = false, okxPassphrase = '' }) {
    const wanted = { LONG: ['BUY', 'LONG', 'Buy'], SHORT: ['SELL', 'SHORT', 'Sell'] }[pyUpper(String(direction || ''))] || [];
    let positions;
    try {
      const t = traderFor(exchange);
      if (exchange === 'bingx' || exchange === 'binance') {
        positions = await call(exchange, 'getPositions', 10, () => t.getPositions(apiKey, apiSecret, symbol));
      } else if (exchange === 'okx') {
        positions = await call(exchange, 'getPositions', 10, () => t.getPositions(apiKey, apiSecret, symbol, okxPassphrase));
      } else {
        positions = await call('bybit', 'getPositions', 10, () => t.getPositions(apiKey, apiSecret, symbol, bybitDemo));
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      logger.debug(pf('reconcile_timeout get_positions %s/%s: %s', exchange, symbol, e && e.message));
      return null;
    }
    for (const p of (positions || [])) {
      let size;
      let side;
      try {
        size = pyFloat(pyOr(pyGet(p, 'size', 0), pyGet(p, 'pos', 0), 0));
        side = pyUpper(pyStr(pyOr(pyGet(p, 'side', ''), pyGet(p, 'posSide', ''))));
      } catch (_e) {
        continue;
      }
      if (size <= 0) continue;
      if (!wanted.length || wanted.map((s) => pyUpper(s)).includes(pyUpper(side))) {
        let slOnExchange;
        try {
          slOnExchange = pyFloat(pyOr(pyGet(p, 'stopLoss', 0), pyGet(p, 'sl', 0), pyGet(p, 'slTriggerPx', 0), 0));
        } catch (_e) {
          slOnExchange = 0.0;
        }
        return {
          size,
          order_id: pyStr(pyOr(pyGet(p, 'order_id', ''), pyGet(p, 'ordId', ''), 'reconciled_after_timeout')),
          side,
          stopLoss: slOnExchange,
        };
      }
    }
    return null;
  }

  async function cancelPendingAfterTimeout({ exchange, apiKey, apiSecret, symbol, bybitDemo = false, okxPassphrase = '' }) {
    let res;
    try {
      const t = traderFor(exchange);
      if (exchange === 'bingx' || exchange === 'binance') {
        res = await call(exchange, 'cancelAllOrders', 10, () => t.cancelAllOrders(apiKey, apiSecret, symbol));
      } else if (exchange === 'okx') {
        res = await call(exchange, 'cancelAllOrders', 10, () => t.cancelAllOrders(apiKey, apiSecret, symbol, okxPassphrase));
      } else {
        res = await call('bybit', 'cancelAllOrders', 10, () => t.cancelAllOrders(apiKey, apiSecret, symbol, bybitDemo));
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      logger.debug(pf('cancel_pending_after_timeout %s/%s: %s', exchange, symbol, e && e.message));
      return 0;
    }
    try {
      if (res !== null && typeof res === 'object' && !Array.isArray(res)) {
        const v = pyOr(pyGet(res, 'cancelled', 0), 0);
        return pyInt(v);
      }
      return 0;
    } catch (_e) {
      return 0;
    }
  }

  async function limitUnfilledGuard({ exchange, apiKey, apiSecret, symbol, direction, bybitDemo = false, okxPassphrase = '', graceS = LIMIT_UNFILLED_GRACE_S_DEFAULT }) {
    try {
      await asleep(graceS);
    } catch (e) {
      if (isCancelledError(e)) throw e;
      return false;
    }
    const reco = await reconcileTimeoutPosition({ exchange, apiKey, apiSecret, symbol, direction, bybitDemo, okxPassphrase });
    if (reco && reco.size > 0) return false;
    const cancelled = await cancelPendingAfterTimeout({ exchange, apiKey, apiSecret, symbol, bybitDemo, okxPassphrase });
    logger.warning(pf('[LIMIT-UNFILLED] %s/%s %s: position size=0 after %ds — LIMIT cancelled (%d order(s)); trade considered unfilled',
      exchange, symbol, direction, graceS, cancelled));
    return true;
  }

  return { reconcileTimeoutPosition, cancelPendingAfterTimeout, limitUnfilledGuard };
}

module.exports = { LIMIT_UNFILLED_GRACE_S_DEFAULT, LIMIT_UNFILLED_GRACE_S_BY_STRATEGY, resolveLimitUnfilledGrace, createReconcile };
