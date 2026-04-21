/**
 * Market context — public macro data trader wants on the dashboard:
 *   • BTC / ETH spot price + 24h change (from Binance public API)
 *   • Crypto Fear & Greed index (alternative.me)
 *   • Funding rate for BTC/ETH perps (Binance + Bybit)
 *
 * All sources are public, no API keys needed. Cached for 60s server-side
 * to avoid hammering public endpoints when every dashboard load fetches.
 */

const https = require('https');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // key → { at, data }

function fetchJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.data);
  return fn().then((data) => { cache.set(key, { at: Date.now(), data }); return data; })
    .catch((err) => {
      logger.warn('marketContext fetch failed', { key, err: err.message });
      // Return last stale value if present, otherwise null
      return hit ? hit.data : null;
    });
}

async function _ticker(symbol) {
  // Binance 24hr endpoint has tickers for spot and is reliable
  const r = await fetchJson('https://api.binance.com/api/v3/ticker/24hr?symbol=' + symbol);
  return {
    symbol,
    price: Number(r.lastPrice),
    change24h: Number(r.priceChangePercent),
    high24h: Number(r.highPrice),
    low24h: Number(r.lowPrice),
    volume24h: Number(r.quoteVolume),
  };
}

function tickers() {
  return cached('tickers', async () => {
    const [btc, eth] = await Promise.all([_ticker('BTCUSDT'), _ticker('ETHUSDT')]);
    return { btc, eth, updatedAt: new Date().toISOString() };
  });
}

function fearGreed() {
  return cached('fng', async () => {
    // alternative.me provides a Crypto Fear & Greed index — standard
    // source cited everywhere. 0=extreme fear, 100=extreme greed.
    const r = await fetchJson('https://api.alternative.me/fng/?limit=1');
    const row = r.data && r.data[0];
    if (!row) return null;
    return {
      value: Number(row.value),
      classification: row.value_classification,
      timestamp: Number(row.timestamp) * 1000,
    };
  });
}

async function _fundingBinance(symbol) {
  const r = await fetchJson('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=' + symbol);
  return {
    venue: 'binance',
    symbol,
    rate: Number(r.lastFundingRate), // per-8h fraction
    nextAt: Number(r.nextFundingTime),
  };
}

function fundingRates() {
  return cached('funding', async () => {
    const [btc, eth] = await Promise.all([_fundingBinance('BTCUSDT'), _fundingBinance('ETHUSDT')]);
    return { btc, eth, updatedAt: new Date().toISOString() };
  });
}

async function summary() {
  // Combine everything into one response so the frontend makes a single call
  const [t, f, fr] = await Promise.all([
    tickers().catch(() => null),
    fearGreed().catch(() => null),
    fundingRates().catch(() => null),
  ]);
  return { tickers: t, fearGreed: f, funding: fr };
}

module.exports = { tickers, fearGreed, fundingRates, summary };
