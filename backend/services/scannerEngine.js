/**
 * Signal Scanner Engine — порт логики из CHM_BREAKER_V4
 * Автономный сканер, работает без Telegram бота.
 *
 * Стратегии: Levels, SMC, Gerchik, Scalping
 * Данные: OKX Public API (бесплатно, без ключей)
 * Цикл: каждые 30 секунд
 */

const https = require('https');
const signalFilter = require('./signalFilter');
const { analyzeScalping } = require('./scalpingV3');
const { analyzeGerchik } = require('./gerchikStrategy');
const momentum = require('./momentumDetector');
const autoTrader = require('./autoTrader');
let telegramService;
try { telegramService = require('./telegramService'); } catch(_) {}
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

// Fetch candles from Binance by date range (free, no auth)
function fetchCandlesByDate(symbol, timeframe, startDate, endDate) {
  return new Promise((resolve) => {
    const tfMap = {'1m':'1m','5m':'5m','15m':'15m','1H':'1h','4H':'4h','1D':'1d','1h':'1h','4h':'4h','1d':'1d'};
    const interval = tfMap[timeframe] || '1h';
    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startMs}&endTime=${endMs}&limit=1000`;

    https.get(url, { headers: { 'User-Agent': 'CHM/2.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const arr = JSON.parse(data);
          if (!Array.isArray(arr) || !arr.length) return resolve([]);
          const candles = arr.map(c => ({
            ts: +c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4],
            volume: +c[5], confirmed: true
          }));
          resolve(candles);
        } catch (e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

// Multi-page Binance fetch for long date ranges (1000 candles per page)
async function fetchCandlesByDateFull(symbol, timeframe, startDate, endDate) {
  const tfMap = {'1m':'1m','5m':'5m','15m':'15m','1H':'1h','4H':'4h','1D':'1d','1h':'1h','4h':'4h','1d':'1d'};
  const interval = tfMap[timeframe] || '1h';
  const tfMs = {'1m':60000,'5m':300000,'15m':900000,'1h':3600000,'4h':14400000,'1d':86400000};
  const barMs = tfMs[interval] || 3600000;
  let startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  let all = [];
  let pages = 0;

  while (startMs < endMs && pages < 20) {
    const batch = await fetchCandlesByDate(symbol, timeframe, new Date(startMs).toISOString(), new Date(Math.min(startMs + 1000 * barMs, endMs)).toISOString());
    if (!batch.length) break;
    all = all.concat(batch);
    startMs = batch[batch.length - 1].ts + barMs;
    pages++;
    if (batch.length < 1000) break;
    await new Promise(r => setTimeout(r, 200));
  }
  return all;
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

// ── V4: Signal Quality Scoring (1-10) ────────────────────────────────────
// Rule-based scoring that replaces ML filter for web platform
function scoreSignal(sig) {
  let score = 5; // base score

  // R:R quality
  const rr = sig.rr || 0;
  if (rr >= 3.0) score += 2;
  else if (rr >= 2.5) score += 1.5;
  else if (rr >= 2.0) score += 1;
  else if (rr < 1.5) score -= 2;

  // Confidence from strategy
  const conf = sig.confidence || 50;
  if (conf >= 80) score += 1.5;
  else if (conf >= 65) score += 1;
  else if (conf < 40) score -= 1;

  // Volume confirmation
  if (sig.volRatio && sig.volRatio >= 2.0) score += 1;
  else if (sig.volRatio && sig.volRatio >= 1.5) score += 0.5;

  // Strategy bonus
  if (sig.signalType === 'Liquidity Grab') score += 0.5; // institutional pattern
  if (sig.isMirror) score += 1; // mirror level (Gerchik)

  // Penalty for extreme RSI
  if (sig.rsi) {
    if (sig.direction === 'long' && sig.rsi > 70) score -= 1;
    if (sig.direction === 'short' && sig.rsi < 30) score -= 1;
  }

  return Math.max(1, Math.min(10, Math.round(score)));
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

  // ATR for structural SL
  const atrArr = atr(candles);
  const lastAtr = atrArr[atrArr.length - 1] || last * 0.01;
  // Volume confirmation
  const volArr = volumeMA(candles);
  const lastVol = candles[candles.length - 1].volume;
  const avgVol = volArr[volArr.length - 1] || 1;
  const volRatio = lastVol / avgVol;

  // EMA200 trend filter
  const ema200 = ema(closes, Math.min(200, closes.length - 1));
  const lastEma200 = ema200[ema200.length - 1];

  // Count level touches for quality scoring
  const countTouches = (levelPrice, tol) => {
    return candles.filter(c => Math.abs(c.low - levelPrice) < tol || Math.abs(c.high - levelPrice) < tol).length;
  };

  // LONG: near support + RSI oversold + volume confirmation
  if (distToSupport < 1.5 && lastRsi < 40) {
    const sl = nearestSupport - lastAtr * 1.5; // ATR-based structural SL
    const risk = last - sl;
    if (risk <= 0) return null;
    const tp1 = last + risk * 2.0;
    const tp2 = last + risk * 3.0;
    const rr = risk > 0 ? (tp1 - last) / risk : 0;
    if (rr < 2.0) return null; // Min R:R = 2.0
    if (volRatio < 0.8) return null; // Volume must be decent
    // Trend filter: prefer longs above EMA200
    const trendBonus = last > lastEma200 ? 10 : -5;
    const touches = countTouches(nearestSupport, lastAtr * 0.3);
    const conf = Math.min(95, 55 + (40 - lastRsi) * 0.5 + Math.min(touches, 5) * 3 + trendBonus + (volRatio > 1.5 ? 5 : 0));
    return { direction: 'long', entry: last, sl: +sl.toFixed(6), tp1: +tp1.toFixed(6), tp2: +tp2.toFixed(6), confidence: Math.round(conf), rr: +rr.toFixed(1), volRatio: +volRatio.toFixed(1) };
  }

  // SHORT: near resistance + RSI overbought + volume confirmation
  if (distToResistance < 1.5 && lastRsi > 60) {
    const sl = nearestResistance + lastAtr * 1.5;
    const risk = sl - last;
    if (risk <= 0) return null;
    const tp1 = last - risk * 2.0;
    const tp2 = last - risk * 3.0;
    const rr = risk > 0 ? (last - tp1) / risk : 0;
    if (rr < 2.0) return null;
    if (volRatio < 0.8) return null;
    const trendBonus = last < lastEma200 ? 10 : -5;
    const touches = countTouches(nearestResistance, lastAtr * 0.3);
    const conf = Math.min(95, 55 + (lastRsi - 60) * 0.5 + Math.min(touches, 5) * 3 + trendBonus + (volRatio > 1.5 ? 5 : 0));
    return { direction: 'short', entry: last, sl: +sl.toFixed(6), tp1: +tp1.toFixed(6), tp2: +tp2.toFixed(6), confidence: Math.round(conf), rr: +rr.toFixed(1), volRatio: +volRatio.toFixed(1) };
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

  // V4: Feed BTC/ETH prices to momentum detector
  try {
    const btcTicker = await fetchTicker('BTCUSDT');
    const ethTicker = await fetchTicker('ETHUSDT');
    if (btcTicker && ethTicker) {
      const mResult = momentum.checkMomentum(btcTicker, ethTicker);
      if (mResult && mResult.triggered) {
        console.log(`[MOMENTUM] ${mResult.asset} moved ${mResult.movePct}% ${mResult.direction} — Relaxed Mode ON`);
      }
    }
  } catch (e) { /* momentum tracking optional */ }

  const isRelaxed = momentum.isRelaxed();

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

      // Gerchik (15m) — V4: BSU → BPU-1 → BPU-2 confirmation
      try {
        const candles15mG = candles15m.length > 0 ? candles15m : await fetchCandles(symbol, '15m', 80);
        if (candles15mG.length > 60) {
          const sig = analyzeGerchik(candles15mG);
          if (sig) {
            const key = `${symbol}-gerchik-${sig.direction}`;
            if (!sentSignals.has(key) || Date.now() - sentSignals.get(key) > DEDUP_TTL) {
              newSignals.push({ symbol, strategy: 'gerchik', timeframe: '15m', ...sig });
              sentSignals.set(key, Date.now());
            }
          }
        }
      } catch (e) { /* gerchik optional */ }

      // Scalping V3 (5m) — VWAP Bounce, Liquidity Grab, Volume Spike
      try {
        const candles5m = await fetchCandles(symbol, '5m', 60);
        if (candles5m.length > 55) {
          const sig = analyzeScalping(candles5m);
          if (sig) {
            const key = `${symbol}-scalping-${sig.direction}-${sig.signalType}`;
            if (!sentSignals.has(key) || Date.now() - sentSignals.get(key) > DEDUP_TTL) {
              newSignals.push({ symbol, strategy: 'scalping', timeframe: '5m', ...sig });
              sentSignals.set(key, Date.now());
            }
          }
        }
      } catch (e) { /* scalping V3 optional */ }

      // Rate limit: 200ms between symbols
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.error(`Scanner error for ${symbol}:`, e.message);
    }
  }

  // Filter + Save to DB
  for (const sig of newSignals) {
    try {
      // V4 Smart Filters — sync checks
      const filterResult = signalFilter.filterSignal(sig);
      if (!filterResult.pass) {
        console.log(`[FILTER] ${sig.symbol} ${sig.direction.toUpperCase()} ${sig.strategy} BLOCKED: ${filterResult.reason}`);
        continue;
      }
      // V4 Async filters (funding rate, spread, BTC correlation)
      try {
        const asyncFilter = await signalFilter.filterSignalAsync(sig);
        if (!asyncFilter.pass) {
          console.log(`[FILTER] ${sig.symbol} ${sig.direction.toUpperCase()} ${sig.strategy} BLOCKED: ${asyncFilter.reason}`);
          continue;
        }
      } catch (_) { /* async filters optional — don't block on network errors */ }

      // V4: Score signal quality (1-10)
      sig.quality = scoreSignal(sig);

      db.prepare(
        `INSERT INTO signal_history (symbol, direction, entry_price, stop_loss, take_profit_1, take_profit_2, strategy, timeframe, confidence, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      ).run(sig.symbol, sig.direction, sig.entry, sig.sl, sig.tp1, sig.tp2, sig.strategy, sig.timeframe, Math.round(sig.confidence));
      console.log(`[SIGNAL] ${sig.symbol} ${sig.direction.toUpperCase()} ${sig.strategy} Q:${sig.quality}/10 conf:${Math.round(sig.confidence)}% ${sig.signalType||''} ${isRelaxed?'[RELAXED]':''}`);
      // V4: Notify all Telegram-connected users
      if(telegramService){try{
        const tgUsers=db.prepare('SELECT id FROM users WHERE telegram_id IS NOT NULL AND telegram_id != ""').all();
        for(const u of tgUsers){telegramService.notifySignal(u.id,sig).catch(()=>{})}
      }catch(_){}}

      // AUTO-TRADE: find ALL active bots matching this signal and execute trades
      try {
        await autoTrader.processSignal(sig);
      } catch (e) {
        console.error(`[AUTO-TRADE] Error processing signal for bots: ${e.message}`);
      }
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

module.exports = { startScanner, stopScanner, scanOnce, fetchCandles, fetchCandlesByDate, fetchCandlesByDateFull, fetchTicker };
