'use strict';
/**
 * traders.js — the auto-trade flow's view of the four exchange traders
 * (auto_trade._get_trader_module + the module-level helpers it reads).
 *
 *   createTraderSet({registry | overrides}) → traderFor(exchange) → handle
 *     handle.inst          the trader instance (services/exchanges/<x>Trader createXTrader)
 *     handle.<method>      the instance methods, positional like the bot (placeTrade, getBalance,
 *                          getPositions, getOpenOrders, cancelAllOrders, getLastPrice, setTrailingSl,
 *                          placeSlTpForPosition, placeTpOrders, placeTradeSplit, getFundingRate,
 *                          getSpreadPct, closePosition)
 *     handle.formatTradeResult / formatTradeResultSplit / priceMultiplier(sym)   module statics
 *   isThreadCall(exchange, fn)  the pybit run_in_executor calls (Bybit) — a wait_for timeout does not
 *                          interrupt them (asyncio.waitFor `shield`)
 *   productionOverrides({...})  trader runtime with cancellable transport / sleep + the auto-trade
 *                          hooks (killswitch, plan gate, events, auth reset)
 *
 * Unknown exchange names resolve to bybit, like the bot.
 */

const bybit = require('../exchanges/bybitTrader');
const bingx = require('../exchanges/bingxTrader');
const binance = require('../exchanges/binanceTrader');
const okx = require('../exchanges/okxTrader');
const { createRegistry, resolveExchange } = require('../exchanges');
const { defaultTransport } = require('../exchanges/transport');
const { realSleep } = require('../exchanges/runtime');
const { cancellableTransport, cancellableSleep } = require('./asyncio');

const MODULES = { bybit, bingx, binance, okx };
const PMULT = {
  bybit: bybit.bybitPriceMultiplier, bingx: bingx.bingxPriceMultiplier, binance: binance.binancePriceMultiplier, okx: okx.okxPriceMultiplier,
};

// bybit_trader.py: functions that `await loop.run_in_executor(...)` the pybit work
const BYBIT_THREAD_FNS = new Set([
  'getBalance', 'placeTpOrders', 'placeTradeSplit', 'setTrailingSl', 'getPositions', 'cancelAllOrders',
  'getOpenOrders', 'cancelOrder', 'closePosition', 'getAllClosedPnl', 'getAccountSummary', 'placeTrade',
]);

function isThreadCall(exchange, fn) {
  return resolveExchange(exchange) === 'bybit' && BYBIT_THREAD_FNS.has(fn);
}

const METHODS = [
  'placeTrade', 'placeTradeSplit', 'placeTpOrders', 'getBalance', 'getPositions', 'getOpenOrders', 'cancelAllOrders',
  'getLastPrice', 'setTrailingSl', 'placeSlTpForPosition', 'getFundingRate', 'getSpreadPct', 'closePosition',
  'cancelOrder', 'getClosedPnl',
];

function makeHandle(exchange, inst) {
  const ex = resolveExchange(exchange);
  const mod = MODULES[ex];
  const h = { exchange: ex, inst, mod };
  for (const m of METHODS) {
    if (inst && typeof inst[m] === 'function') h[m] = (...a) => inst[m](...a);
  }
  h.formatTradeResult = (...a) => mod.formatTradeResult(...a);
  if (ex === 'bybit') h.formatTradeResultSplit = (...a) => mod.formatTradeResultSplit(...a);
  h.priceMultiplier = (sym) => PMULT[ex](sym);
  return h;
}

/**
 * The trader runtime of the auto-trade instances. `extra` = further runtime fields (tests: a fake
 * exchange's clock — now / monotonic — kv, log, env, random); transport / sleep stay cancellable.
 */
function productionOverrides({ killswitch = null, planGate = null, events = null, onAuthReset = null, transport = null, sleep = null, extra = null } = {}) {
  const o = { ...(extra || {}) };
  o.transport = cancellableTransport(transport || defaultTransport());
  o.sleep = cancellableSleep(sleep || realSleep);
  if (killswitch) o.killswitch = killswitch;
  if (planGate) o.planGate = planGate;
  if (events) o.events = events;
  if (onAuthReset) o.onAuthReset = onAuthReset;
  return o;
}

function createTraderSet({ registry = null, overrides = {}, instances = null } = {}) {
  const reg = registry || createRegistry({ overrides, instances: instances || {} });
  const handles = new Map();
  return function traderFor(exchange, demo = false) {
    const ex = resolveExchange(exchange);
    const k = `${ex}:${demo ? 1 : 0}`;
    if (!handles.has(k)) handles.set(k, makeHandle(ex, reg(ex, demo)));
    return handles.get(k);
  };
}

module.exports = { MODULES, PMULT, BYBIT_THREAD_FNS, isThreadCall, makeHandle, productionOverrides, createTraderSet };
