/**
 * Market data service — candles (with DB cache), symbols, tickers.
 *
 * Candle caching strategy:
 *  - `fetchCandles(exchange, symbol, timeframe, since?, limit?)` returns
 *    Array of [openTime, open, high, low, close, volume, closeTime] tuples.
 *  - First checks `candles_cache` table, fills gaps from CCXT, writes back.
 *  - Fresh "last candle" (still forming) is never cached — only closed bars.
 *
 * Public tickers / symbols use only public CCXT (no key required).
 * Private endpoints (balance) live in exchangeService.
 */

const ccxt = require('ccxt');
const db = require('../models/database');
const logger = require('../utils/logger');

const TF_MINUTES = {
  '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
  '1h': 60, '2h': 120, '4h': 240, '6h': 360, '12h': 720,
  '1d': 1440, '1w': 10080,
};

// ── Public CCXT client cache (no auth) ───────────────────────────────────
const publicClients = new Map();

function getPublicClient(exchange) {
  if (publicClients.has(exchange)) return publicClients.get(exchange);
  if (typeof ccxt[exchange] !== 'function') {
    const err = new Error(`Unsupported exchange: ${exchange}`);
    err.statusCode = 400; err.code = 'UNSUPPORTED_EXCHANGE';
    throw err;
  }
  const client = new ccxt[exchange]({ enableRateLimit: true, timeout: 15000 });
  publicClients.set(exchange, client);
  return client;
}

// ── Symbols cache (1 hour in-memory) ─────────────────────────────────────
const symbolsCache = new Map(); // exchange → { symbols, fetchedAt }
const SYMBOLS_TTL_MS = 60 * 60 * 1000;

async function fetchSymbols(exchange) {
  const cached = symbolsCache.get(exchange);
  if (cached && Date.now() - cached.fetchedAt < SYMBOLS_TTL_MS) return cached.symbols;
  const client = getPublicClient(exchange);
  const markets = await client.loadMarkets();
  const symbols = Object.values(markets)
    .filter((m) => m.active !== false)
    .map((m) => ({
      symbol: m.symbol,
      base: m.base,
      quote: m.quote,
      type: m.type,
      contract: Boolean(m.contract),
      linear: Boolean(m.linear),
      inverse: Boolean(m.inverse),
      settle: m.settle || null,
    }));
  symbolsCache.set(exchange, { symbols, fetchedAt: Date.now() });
  return symbols;
}

async function fetchTicker(exchange, symbol) {
  const client = getPublicClient(exchange);
  const t = await client.fetchTicker(symbol);
  return {
    symbol: t.symbol,
    last: t.last,
    bid: t.bid,
    ask: t.ask,
    high24h: t.high,
    low24h: t.low,
    volume24h: t.quoteVolume || t.baseVolume,
    change24hPct: t.percentage,
    timestamp: t.timestamp,
  };
}

// ── Candles (with DB cache) ──────────────────────────────────────────────

function tfToMs(tf) {
  const m = TF_MINUTES[tf];
  if (!m) throw new Error('unknown timeframe: ' + tf);
  return m * 60 * 1000;
}

function readCachedCandles(exchange, symbol, timeframe, fromMs, toMs) {
  return db.prepare(`
    SELECT open_time, open, high, low, close, volume, close_time
    FROM candles_cache
    WHERE exchange = ? AND symbol = ? AND timeframe = ?
      AND open_time >= ? AND open_time <= ?
    ORDER BY open_time ASC
  `).all(exchange, symbol, timeframe, fromMs, toMs);
}

function upsertCandles(exchange, symbol, timeframe, candles) {
  if (!candles.length) return;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO candles_cache
      (exchange, symbol, timeframe, open_time, open, high, low, close, volume, close_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows) => {
    for (const c of rows) {
      stmt.run(
        exchange, symbol, timeframe,
        c[0], c[1], c[2], c[3], c[4], c[5],
        c[6] != null ? c[6] : c[0] + tfToMs(timeframe) - 1
      );
    }
  });
  tx(candles);
}

/**
 * Fetch candles.
 *  - If `since` not given, returns most recent `limit` candles.
 *  - Always skips the currently-forming candle (timestamp > now - tf).
 *
 * @returns {Promise<Array<Array<number>>>} rows: [openTime, o, h, l, c, v, closeTime]
 */
async function fetchCandles(exchange, symbol, timeframe, { since, limit = 500 } = {}) {
  const tfMs = tfToMs(timeframe);
  const now = Date.now();
  const toMs = now - tfMs; // exclude forming candle

  let fromMs;
  if (since) fromMs = since;
  else fromMs = Math.max(0, toMs - limit * tfMs);

  // Normalize to candle boundaries
  fromMs = Math.floor(fromMs / tfMs) * tfMs;

  // Read cache
  let cached = readCachedCandles(exchange, symbol, timeframe, fromMs, toMs);

  // Determine missing ranges — naive: if we don't have the first expected or
  // there's a gap bigger than 2 candles, fetch from the last cached +1 onward.
  const expectedStart = fromMs;
  const expectedEnd = Math.floor(toMs / tfMs) * tfMs;
  const expectedCount = Math.max(0, Math.floor((expectedEnd - expectedStart) / tfMs) + 1);

  if (cached.length < expectedCount) {
    // Fetch from CCXT starting at last-cached+1 (or expectedStart if nothing)
    const cursorFrom = cached.length
      ? cached[cached.length - 1].open_time + tfMs
      : expectedStart;

    const client = getPublicClient(exchange);
    let fetched = [];
    try {
      fetched = await client.fetchOHLCV(symbol, timeframe, cursorFrom, Math.min(1000, expectedCount));
    } catch (e) {
      logger.warn('fetchOHLCV failed', { exchange, symbol, timeframe, err: e.message });
      // Return whatever cache we have
      return cached.map((r) => [r.open_time, r.open, r.high, r.low, r.close, r.volume, r.close_time]);
    }
    // Filter to <= toMs (drop forming)
    fetched = fetched.filter((c) => c[0] <= toMs);
    upsertCandles(exchange, symbol, timeframe, fetched);
    // Re-read
    cached = readCachedCandles(exchange, symbol, timeframe, fromMs, toMs);
  }

  // Trim to last `limit` if we got more (e.g. caller asked recent-N)
  if (!since && cached.length > limit) cached = cached.slice(-limit);

  return cached.map((r) => [r.open_time, r.open, r.high, r.low, r.close, r.volume, r.close_time]);
}

/**
 * Cache-only read (no network). Used by strategies/backtests that don't
 * want unexpected I/O latency.
 */
function readCandlesFromCache(exchange, symbol, timeframe, fromMs, toMs) {
  const rows = readCachedCandles(exchange, symbol, timeframe, fromMs, toMs);
  return rows.map((r) => [r.open_time, r.open, r.high, r.low, r.close, r.volume, r.close_time]);
}

// For tests
function _clearSymbolsCache() { symbolsCache.clear(); }
function _clearPublicClients() { publicClients.clear(); }

module.exports = {
  fetchCandles,
  fetchSymbols,
  fetchTicker,
  readCandlesFromCache,
  tfToMs,
  TF_MINUTES,
  _clearSymbolsCache,
  _clearPublicClients,
};
