'use strict';
/**
 * services/exchanges — one adapter per exchange over the four bot-parity traders.
 *
 *   const { getTrader } = require('./services/exchanges');
 *   const t = getTrader('okx');
 *   await t.placeTrade(creds, { symbol, direction, entry, sl, tp1, riskPct, leverage, tp2, tp3, ... });
 *
 * `creds` is the shape exchangeService.getCredentials() returns:
 *   { apiKey, apiSecret, passphrase?, demo? | testnet? }
 *
 * Dispatch reproduces the bot's call sites (auto_trade.py `trader.place_trade(...,
 * **({"demo": bybit_demo} if bybit else {"passphrase": okx_passphrase} if okx else {}))`,
 * trade_anomaly_detector._panic_close_position, balance_cache.get_cached_balance):
 *   bybit   → `demo` travels with every call (api-demo.bybit.com host)
 *   okx     → `passphrase` travels with every call; demo = an instance with the
 *             `x-simulated-trading: 1` header (addition, not in the bot)
 *   binance → demo = an instance on the USDⓈ-M futures testnet base URL (addition)
 *   bingx   → no demo/testnet in the bot; the flag is ignored
 * placeTradeSplit is Bybit-only in the bot; for bingx / binance / okx auto_trade falls back
 * to the MIDPOINT entry through place_trade (FIX-B4) — the adapter does the same.
 * Unknown exchange names resolve to bybit like auto_trade._get_trader_module (callers should
 * validate with isSupportedExchange first).
 *
 * Every method returns exactly what the underlying trader returns (bot dict shapes, snake_case
 * keys, Russian error texts).
 */

const bybit = require('./bybitTrader');
const bingx = require('./bingxTrader');
const binance = require('./binanceTrader');
const okx = require('./okxTrader');
const { log: mdLog } = require('../marketData/mdLog');
const { pyFloatStr } = require('./pyCompat');

const EXCHANGES = Object.freeze(['bybit', 'bingx', 'binance', 'okx']);
const BINANCE_TESTNET_URL = 'https://testnet.binancefuture.com';

const MODULES = { bybit, bingx, binance, okx };
const FACTORIES = {
  bybit: (o) => bybit.createBybitTrader(o),
  bingx: (o) => bingx.createBingxTrader(o),
  binance: (o) => binance.createBinanceTrader(o),
  okx: (o) => okx.createOkxTrader(o),
};

function isSupportedExchange(exchange) {
  return EXCHANGES.includes(String(exchange || '').toLowerCase());
}

/** auto_trade._get_trader_module: bingx / binance / okx, anything else → bybit. */
function resolveExchange(exchange) {
  const ex = String(exchange || '').toLowerCase();
  return EXCHANGES.includes(ex) ? ex : 'bybit';
}

const isDemo = (creds) => Boolean(creds && (creds.demo !== undefined ? creds.demo : creds.testnet));

/**
 * Instance registry. `overrides` (runtime injection: transport, clock, kv, killswitch, …) is
 * applied to every instance it creates; tests pass `instances` to substitute traders.
 */
function createRegistry({ overrides = {}, instances = {} } = {}) {
  const cache = new Map();
  return function instanceFor(exchange, demo) {
    const k = `${exchange}:${demo && (exchange === 'okx' || exchange === 'binance') ? 'demo' : 'live'}`;
    if (instances[k]) return instances[k];
    if (instances[exchange] && k.endsWith(':live')) return instances[exchange];
    if (!cache.has(k)) {
      const o = { ...overrides };
      if (k === 'okx:demo') o.demo = true;
      if (k === 'binance:demo') o.baseUrl = BINANCE_TESTNET_URL;
      cache.set(k, FACTORIES[exchange](o));
    }
    return cache.get(k);
  };
}

let _defaultRegistry = null;
function defaultRegistry() {
  if (!_defaultRegistry) _defaultRegistry = createRegistry();
  return _defaultRegistry;
}

/**
 * @param {string} exchange  bybit | bingx | binance | okx
 * @param {object} [opts]    { registry } — from createRegistry(); defaults to process-wide traders
 */
function getTrader(exchange, opts = {}) {
  const ex = resolveExchange(exchange);
  const registry = opts.registry || defaultRegistry();
  const log = opts.log || mdLog;
  const inst = (creds) => registry(ex, isDemo(creds));
  const k = (c) => c.apiKey;
  const s = (c) => c.apiSecret;
  const pp = (c) => (c && c.passphrase) || '';

  async function placeTrade(creds, p) {
    const o = {
      tp2: p.tp2 ?? 0.0, tp3: p.tp3 ?? 0.0, riskMode: p.riskMode ?? 'risk', orderType: p.orderType ?? 'Limit',
      tradeId: p.tradeId ?? '', userId: p.userId ?? 0, allowLowNotionalBoost: Boolean(p.allowLowNotionalBoost),
    };
    if (ex === 'bybit') o.demo = isDemo(creds);
    if (ex === 'okx') o.passphrase = pp(creds);
    return inst(creds).placeTrade(k(creds), s(creds), p.symbol, p.direction, p.entry, p.sl, p.tp1, p.riskPct, p.leverage, o);
  }

  async function placeTradeSplit(creds, p) {
    if (ex === 'bybit') {
      return inst(creds).placeTradeSplit(k(creds), s(creds), p.symbol, p.direction, p.entryLo, p.entryHi, p.sl, p.tp1, p.riskPct, p.leverage, {
        tp2: p.tp2 ?? 0.0, tp3: p.tp3 ?? 0.0, demo: isDemo(creds), userId: p.userId ?? 0,
      });
    }
    // FIX-B4 (auto_trade): split entry is Bybit-only → midpoint through place_trade
    log.warning(`auto_trade: split-entry не поддерживается ${ex.toUpperCase()} (uid=${p.userId ?? 0} sym=${p.symbol}) — используем midpoint`);
    return placeTrade(creds, { ...p, entry: (p.entryLo + p.entryHi) / 2 });
  }

  async function setTrailingSl(creds, { symbol, newSl, direction, posIdx = 0 }) {
    if (ex === 'bybit') return inst(creds).setTrailingSl(k(creds), s(creds), symbol, newSl, direction, posIdx, isDemo(creds));
    if (ex === 'okx') return inst(creds).setTrailingSl(k(creds), s(creds), symbol, newSl, direction, posIdx, pp(creds));
    return inst(creds).setTrailingSl(k(creds), s(creds), symbol, newSl, direction, posIdx);
  }

  async function setBreakeven(creds, { symbol, entry, direction, posIdx = 0 }) {
    if (ex === 'bybit') return inst(creds).setBreakeven(k(creds), s(creds), symbol, entry, direction, posIdx, isDemo(creds));
    if (ex === 'okx') return inst(creds).setBreakeven(k(creds), s(creds), symbol, entry, direction, posIdx, pp(creds));
    return inst(creds).setBreakeven(k(creds), s(creds), symbol, entry, direction, posIdx);
  }

  /** _panic_close_position: bybit str(size)+pos_idx+demo · bingx/binance float(size)+pos_idx · okx whole position. */
  async function closePosition(creds, { symbol, side, size, posIdx = 0 }) {
    if (ex === 'bybit') return inst(creds).closePosition(k(creds), s(creds), symbol, side, typeof size === 'number' ? pyFloatStr(size) : size, posIdx, isDemo(creds));
    if (ex === 'okx') return inst(creds).closePosition(k(creds), s(creds), symbol, side, pp(creds));
    return inst(creds).closePosition(k(creds), s(creds), symbol, side, Number(size), posIdx);
  }

  async function cancelAllOrders(creds, symbol) {
    if (ex === 'bybit') return inst(creds).cancelAllOrders(k(creds), s(creds), symbol, isDemo(creds));
    if (ex === 'okx') return inst(creds).cancelAllOrders(k(creds), s(creds), symbol, pp(creds));
    return inst(creds).cancelAllOrders(k(creds), s(creds), symbol);
  }

  async function getOpenOrders(creds) {
    if (ex === 'bybit') return inst(creds).getOpenOrders(k(creds), s(creds), isDemo(creds));
    if (ex === 'okx') return inst(creds).getOpenOrders(k(creds), s(creds), pp(creds));
    return inst(creds).getOpenOrders(k(creds), s(creds));
  }

  async function getPositions(creds, symbol = null) {
    if (ex === 'bybit') return inst(creds).getPositions(k(creds), s(creds), symbol || '', isDemo(creds));
    if (ex === 'okx') return inst(creds).getPositions(k(creds), s(creds), symbol, pp(creds));
    return inst(creds).getPositions(k(creds), s(creds), symbol);
  }

  async function getBalance(creds) {
    if (ex === 'bybit') return inst(creds).getBalance(k(creds), s(creds), isDemo(creds));
    if (ex === 'okx') return inst(creds).getBalance(k(creds), s(creds), pp(creds));
    return inst(creds).getBalance(k(creds), s(creds));
  }

  async function getClosedPnl(creds, symbol) {
    if (ex === 'bybit') return inst(creds).getClosedPnl(k(creds), s(creds), symbol, isDemo(creds));
    if (ex === 'okx') return inst(creds).getClosedPnl(k(creds), s(creds), symbol, pp(creds));
    return inst(creds).getClosedPnl(k(creds), s(creds), symbol);
  }

  async function testConnection(creds) {
    if (ex === 'bybit') return inst(creds).testConnection(k(creds), s(creds), isDemo(creds));
    if (ex === 'okx') return inst(creds).testConnection(k(creds), s(creds), pp(creds));
    return inst(creds).testConnection(k(creds), s(creds));
  }

  /** auto_trade pre-flight price (`_pre_trader.get_last_price(api_key, api_secret, symbol)`). */
  async function getLastPrice(creds, symbol) {
    return inst(creds).getLastPrice(k(creds), s(creds), symbol);
  }

  const mod = MODULES[ex];
  const priceMultiplier = {
    bybit: bybit.bybitPriceMultiplier, bingx: bingx.bingxPriceMultiplier, binance: binance.binancePriceMultiplier, okx: okx.okxPriceMultiplier,
  }[ex];

  return {
    exchange: ex,
    placeTrade, placeTradeSplit, setTrailingSl, setBreakeven, closePosition, cancelAllOrders, getOpenOrders, getPositions,
    getBalance, getClosedPnl, testConnection, getLastPrice,
    formatTradeResult: mod.formatTradeResult,
    priceMultiplier,
    instance: (creds = {}) => inst(creds),
  };
}

module.exports = {
  EXCHANGES, BINANCE_TESTNET_URL, getTrader, createRegistry, isSupportedExchange, resolveExchange,
  bybit, bingx, binance, okx,
  balanceCache: require('./balanceCache'),
};
