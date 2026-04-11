/**
 * Signal Scanner Engine — порт логики из CHM_BREAKER_V4
 * Автономный сканер, работает без Telegram бота.
 *
 * Стратегии: Levels, SMC, Gerchik, Scalping
 * Данные: OKX Public API (бесплатно, без ключей)
 * Цикл: каждые 30 секунд
 */

const https = require('https');
const db = require('../models/database');

// ── OKX Public API (no auth required) ──────────────────────────────────
function fetchCandles(symbol, timeframe = '1H', limit = 100, before = '') {
  return new Promise((resolve, reject) => {
    const instId = symbol.replace('USDT', '-USDT-SWAP');
    let url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${timeframe}&limit=${Math.min(limit, 300)}`;
    if (before) url += `&before=${before}`;
    https.get(url, { headers: { 'User-Agent': 'CHM/2.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.data || !json.data.length) return resolve([]);
          const candles = json.data.reverse().map(c => ({
            ts: +c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4],
            volume: +c[5], confirmed: c[8] === '1'
          }));
          resolve(candles);
        } catch (e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

// Fetch multiple pages of candles for backtesting
async function fetchCandlesMulti(symbol, timeframe, totalLimit = 500) {
  let all = [];
  let before = '';
  const perPage = 300;
  const pages = Math.ceil(totalLimit / perPage);
  for (let p = 0; p < pages; p++) {
    const batch = await fetchCandles(symbol, timeframe, perPage, before);
    if (!batch.length) break;
    all = all.concat(batch);
    before = '' + batch[0].ts; // oldest timestamp for next page
    if (batch.length < perPage) break;
    await new Promise(r => setTimeout(r, 200));
  }
  // Sort by time ascending and deduplicate
  all.sort((a, b) => a.ts - b.ts);
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.ts)) return false; seen.add(c.ts); return true; });
}

function fetchTicker(symbol) {
  return new Promise((resolve, reject) => {
    const instId = symbol.replace('USDT', '-USDT-SWAP');
    const url = `https://www.okx.com/api/v5/market/ticker?instId=${instId}`;
    https.get(url, { headers: { 'User-Agent': 'CHM/2.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const t = json.data?.[0];
          if (!t) return resolve(null);
          resolve({ last: +t.last, high24h: +t.high24h, low24h: +t.low24h, vol24h: +t.vol24h, change24h: ((+t.last - +t.open24h) / +t.open24h * 100) });
        } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ── Technical Indicators ───────────────────────────────────────────────
function ema(data, period) {
  const k = 2 / (period + 1);
  const result = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return Array(closes.length).fill(50);
  const result = Array(period).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period; avgLoss /= period;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macdLine, signal);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macd: macdLine, signal: signalLine, histogram };
}

function atr(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return ema(trs, period);
}

function volumeMA(candles, period = 20) {
  return ema(candles.map(c => c.volume), period);
}

// ── Strategy: Levels (Support/Resistance) ──────────────────────────────
function strategyLevels(candles) {
  if (candles.length < 50) return null;
  const closes = candles.map(c => c.close);
  const last = closes[closes.length - 1];
  const rsiVal = rsi(closes, 14);
  const lastRsi = rsiVal[rsiVal.length - 1];

  // Find pivot levels (simplified KDE)
  const pivotStrength = 7;
  const levels = [];
  for (let i = pivotStrength; i < candles.length - pivotStrength; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = 1; j <= pivotStrength; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) isHigh = false;
      if (candles[i - j].low <= c.low || candles[i + j].low <= c.low) isLow = false;
    }
    if (isHigh) levels.push({ price: c.high, type: 'resistance' });
    if (isLow) levels.push({ price: c.low, type: 'support' });
  }

  // Find nearest levels
  const supports = levels.filter(l => l.type === 'support' && l.price < last).sort((a, b) => b.price - a.price);
  const resistances = levels.filter(l => l.type === 'resistance' && l.price > last).sort((a, b) => a.price - b.price);

  if (!supports.length || !resistances.length) return null;

  const nearestSupport = supports[0].price;
  const nearestResistance = resistances[0].price;
  const distToSupport = (last - nearestSupport) / last * 100;
  const distToResistance = (nearestResistance - last) / last * 100;

  // Signal logic
  if (distToSupport < 1.5 && lastRsi < 40) {
    const sl = nearestSupport * 0.985;
    const tp1 = last + (last - sl) * 1.5;
    const tp2 = last + (last - sl) * 2.5;
    const rr = (tp1 - last) / (last - sl);
    if (rr < 1.5) return null;
    return { direction: 'long', entry: last, sl, tp1, tp2, confidence: Math.min(90, 60 + (40 - lastRsi) + levels.length), rr: +rr.toFixed(1) };
  }
  if (distToResistance < 1.5 && lastRsi > 60) {
    const sl = nearestResistance * 1.015;
    const tp1 = last - (sl - last) * 1.5;
    const tp2 = last - (sl - last) * 2.5;
    const rr = (last - tp1) / (sl - last);
    if (rr < 1.5) return null;
    return { direction: 'short', entry: last, sl, tp1, tp2, confidence: Math.min(90, 60 + (lastRsi - 60) + levels.length), rr: +rr.toFixed(1) };
  }
  return null;
}

// ── Strategy: Scalping (MACD + RSI + Volume) ───────────────────────────
function strategyScalping(candles) {
  if (candles.length < 30) return null;
  const closes = candles.map(c => c.close);
  const last = closes[closes.length - 1];
  const rsiVal = rsi(closes, 14);
  const lastRsi = rsiVal[rsiVal.length - 1];
  const prevRsi = rsiVal[rsiVal.length - 2];
  const m = macd(closes);
  const lastHist = m.histogram[m.histogram.length - 1];
  const prevHist = m.histogram[m.histogram.length - 2];
  const volMa = volumeMA(candles);
  const lastVol = candles[candles.length - 1].volume;
  const lastVolMa = volMa[volMa.length - 1];
  const atrVal = atr(candles);
  const lastAtr = atrVal[atrVal.length - 1];

  // LONG: MACD crosses up + RSI < 45 + volume > MA
  if (prevHist < 0 && lastHist > 0 && lastRsi < 45 && lastVol > lastVolMa * 1.1) {
    const sl = last - lastAtr * 1.5;
    const tp1 = last + lastAtr * 1.5;
    const tp2 = last + lastAtr * 3;
    return { direction: 'long', entry: last, sl, tp1, tp2, confidence: Math.min(85, 55 + (45 - lastRsi) + (lastVol / lastVolMa - 1) * 20), rr: 1.5 };
  }
  // SHORT: MACD crosses down + RSI > 55 + volume > MA
  if (prevHist > 0 && lastHist < 0 && lastRsi > 55 && lastVol > lastVolMa * 1.1) {
    const sl = last + lastAtr * 1.5;
    const tp1 = last - lastAtr * 1.5;
    const tp2 = last - lastAtr * 3;
    return { direction: 'short', entry: last, sl, tp1, tp2, confidence: Math.min(85, 55 + (lastRsi - 55) + (lastVol / lastVolMa - 1) * 20), rr: 1.5 };
  }
  return null;
}

// ── Strategy: SMC (Order Blocks + Liquidity) ───────────────────────────
function strategySMC(candles) {
  if (candles.length < 50) return null;
  const closes = candles.map(c => c.close);
  const last = closes[closes.length - 1];
  const lastRsi = rsi(closes, 14).pop();
  const lastAtr = atr(candles).pop();

  // Find Order Blocks (large candle bodies followed by reversal)
  for (let i = candles.length - 10; i < candles.length - 2; i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    const avgBody = candles.slice(i - 10, i).reduce((s, x) => s + Math.abs(x.close - x.open), 0) / 10;

    if (body > avgBody * 2) { // Large candle = potential OB
      const isBullOB = c.close > c.open; // Bullish OB
      const nextCandles = candles.slice(i + 1, i + 4);
      const swept = nextCandles.some(n => isBullOB ? n.low < c.low : n.high > c.high);

      if (swept) {
        // Liquidity swept — look for signal
        const retraced = isBullOB
          ? last < c.close && last > c.open
          : last > c.close && last < c.open;

        if (retraced) {
          if (isBullOB && lastRsi < 45) {
            const sl = c.low - lastAtr * 0.5;
            return { direction: 'long', entry: last, sl, tp1: last + (last - sl) * 2, tp2: last + (last - sl) * 3, confidence: Math.min(92, 70 + body / avgBody * 5), rr: 2.0 };
          }
          if (!isBullOB && lastRsi > 55) {
            const sl = c.high + lastAtr * 0.5;
            return { direction: 'short', entry: last, sl, tp1: last - (sl - last) * 2, tp2: last - (sl - last) * 3, confidence: Math.min(92, 70 + body / avgBody * 5), rr: 2.0 };
          }
        }
      }
    }
  }
  return null;
}

// ── Main Scanner Loop ──────────────────────────────────────────────────
const SCAN_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT',
  'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'MATICUSDT', 'LINKUSDT', 'UNIUSDT',
  'ATOMUSDT', 'LTCUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT', 'NEARUSDT',
  'SUIUSDT', 'INJUSDT',
];
const SCAN_INTERVAL = 30000; // 30 seconds
const DEDUP_TTL = 2 * 3600000; // 2 hours
const sentSignals = new Map(); // symbol+direction → timestamp

let scannerRunning = false;
let scannerTimer = null;

async function scanOnce() {
  const newSignals = [];

  for (const symbol of SCAN_SYMBOLS) {
    try {
      // Levels (1H)
      const candles1h = await fetchCandles(symbol, '1H', 100);
      if (candles1h.length > 50) {
        const sig = strategyLevels(candles1h);
        if (sig) {
          const key = `${symbol}-levels-${sig.direction}`;
          if (!sentSignals.has(key) || Date.now() - sentSignals.get(key) > DEDUP_TTL) {
            newSignals.push({ symbol, strategy: 'levels', timeframe: '1H', ...sig });
            sentSignals.set(key, Date.now());
          }
        }
      }

      // Scalping (15m)
      const candles15m = await fetchCandles(symbol, '15m', 50);
      if (candles15m.length > 30) {
        const sig = strategyScalping(candles15m);
        if (sig) {
          const key = `${symbol}-scalping-${sig.direction}`;
          if (!sentSignals.has(key) || Date.now() - sentSignals.get(key) > DEDUP_TTL) {
            newSignals.push({ symbol, strategy: 'scalping', timeframe: '15m', ...sig });
            sentSignals.set(key, Date.now());
          }
        }
      }

      // SMC (4H)
      const candles4h = await fetchCandles(symbol, '4H', 100);
      if (candles4h.length > 50) {
        const sig = strategySMC(candles4h);
        if (sig) {
          const key = `${symbol}-smc-${sig.direction}`;
          if (!sentSignals.has(key) || Date.now() - sentSignals.get(key) > DEDUP_TTL) {
            newSignals.push({ symbol, strategy: 'smc', timeframe: '4H', ...sig });
            sentSignals.set(key, Date.now());
          }
        }
      }

      // Rate limit: 200ms between symbols
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.error(`Scanner error for ${symbol}:`, e.message);
    }
  }

  // Save to DB
  for (const sig of newSignals) {
    try {
      db.prepare(
        `INSERT INTO signal_history (symbol, direction, entry_price, stop_loss, take_profit_1, take_profit_2, strategy, timeframe, confidence, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      ).run(sig.symbol, sig.direction, sig.entry, sig.sl, sig.tp1, sig.tp2, sig.strategy, sig.timeframe, Math.round(sig.confidence));
      console.log(`[SIGNAL] ${sig.symbol} ${sig.direction.toUpperCase()} ${sig.strategy} conf:${Math.round(sig.confidence)}%`);
    } catch (e) {
      console.error('Signal save error:', e.message);
    }
  }

  // Cleanup old dedup entries
  for (const [key, ts] of sentSignals) {
    if (Date.now() - ts > DEDUP_TTL) sentSignals.delete(key);
  }

  return newSignals;
}

function startScanner() {
  if (scannerRunning) return;
  scannerRunning = true;
  console.log('[SCANNER] Started — scanning', SCAN_SYMBOLS.length, 'symbols every', SCAN_INTERVAL / 1000, 's');

  // Run immediately, then every SCAN_INTERVAL
  scanOnce().catch(e => console.error('[SCANNER] Initial scan error:', e.message));
  scannerTimer = setInterval(() => {
    scanOnce().catch(e => console.error('[SCANNER] Scan error:', e.message));
  }, SCAN_INTERVAL);
}

function stopScanner() {
  if (scannerTimer) clearInterval(scannerTimer);
  scannerRunning = false;
  console.log('[SCANNER] Stopped');
}

module.exports = { startScanner, stopScanner, scanOnce, fetchCandles, fetchCandlesMulti, fetchTicker };
