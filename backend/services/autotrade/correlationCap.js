'use strict';
/**
 * correlationCap.js — port of correlation_cap.py ([W1.3 CORRELATION-CAP]).
 *
 *   getCorrelation(a, b)  Pearson of the 1H close returns (last 100 closes, pct_change().dropna(),
 *                         both cut to the shorter length, then aligned on the open-time index the
 *                         way pandas Series.corr does: inner join of the timestamps). < 50 bars /
 *                         cache miss / NaN → null; cached 300 s per sorted pair.
 *   checkCorrelationCap({userId, newSymbol, newDirection, threshold}) → {blocked, max_corr,
 *                         with_symbol, checked_count} over the user's same-direction rows with
 *                         result NULL/'' (rows without an order count too — the bot's SQL).
 *
 * np.corrcoef sums with BLAS; the port sums sequentially (strategies/common/series.pearson), so
 * the coefficient can differ from the bot's in the last bits — it is compared to the threshold
 * and printed with 2–3 decimals.
 */

const { pctChange, pearson } = require('../../strategies/common/series');
const { pyRound } = require('../../strategies/common/pyround');
const { pf } = require('./pyfmt');

const CORR_CACHE_TTL = 300.0;
const LOOKBACK_BARS = 100;
const MIN_BARS_FOR_CORR = 50;

const pairKey = (a, b) => (a <= b ? `${a}|${b}` : `${b}|${a}`);

/** close.iloc[-100:].pct_change().dropna() as [t[], r[]]. */
function returnsSeries(df) {
  const n = df.length;
  const s = Math.max(0, n - LOOKBACK_BARS);
  const closes = Array.from(df.c).slice(s);
  const ts = Array.from(df.t).slice(s);
  const r = pctChange(closes, 1);
  const outT = [];
  const outR = [];
  for (let i = 0; i < r.length; i++) {
    if (r[i] === r[i]) { outT.push(ts[i]); outR.push(r[i]); }
  }
  return [outT, outR];
}

function createCorrelationCap({ db = null, cache = null, now = () => Date.now() / 1000, log = null } = {}) {
  const dbOf = () => (db ? db : require('../../models/database'));
  const cacheOf = () => (cache ? cache : require('../marketData/candleCache'));
  const logger = log || require('../marketData/mdLog').log;
  const corrCache = new Map();   // pairKey → [corr, expiry]

  async function getCorrelation(symbolA, symbolB) {
    if (symbolA === symbolB) return 1.0;
    const key = pairKey(symbolA, symbolB);
    const nowTs = now();
    const cached = corrCache.get(key);
    if (cached && cached[1] > nowTs) return cached[0];
    try {
      const dfA = await cacheOf().getCandles(symbolA, '1H');
      const dfB = await cacheOf().getCandles(symbolB, '1H');
      if (!dfA || !dfB) {
        logger.debug(pf('[CORR-CAP-SKIP] %s/%s: cache miss — correlation NOT checked, trade allowed by default', symbolA, symbolB));
        return null;
      }
      if (dfA.length < MIN_BARS_FOR_CORR || dfB.length < MIN_BARS_FOR_CORR) {
        logger.debug(pf('[CORR-CAP-SKIP] %s/%s: insufficient history (a=%d/b=%d bars, need=%d) — corr NOT checked',
          symbolA, symbolB, dfA.length, dfB.length, MIN_BARS_FOR_CORR));
        return null;
      }
      let [ta, ra] = returnsSeries(dfA);
      let [tb, rb] = returnsSeries(dfB);
      const n = Math.min(ra.length, rb.length);
      if (n < MIN_BARS_FOR_CORR) {
        logger.debug(pf('[CORR-CAP-SKIP] %s/%s: post-pct_change samples=%d < %d — corr NOT checked', symbolA, symbolB, n, MIN_BARS_FOR_CORR));
        return null;
      }
      ta = ta.slice(ta.length - n); ra = ra.slice(ra.length - n);
      tb = tb.slice(tb.length - n); rb = rb.slice(rb.length - n);
      // Series.corr: align(join="inner") on the open-time index, then nancorr
      const posB = new Map(tb.map((t, i) => [t, i]));
      const xa = [];
      const xb = [];
      for (let i = 0; i < ta.length; i++) {
        const j = posB.get(ta[i]);
        if (j === undefined) continue;
        if (ra[i] === ra[i] && rb[j] === rb[j]) { xa.push(ra[i]); xb.push(rb[j]); }
      }
      if (!xa.length) return null;
      const corr = pearson(xa, xb);
      if (corr !== corr) return null;
      corrCache.set(key, [corr, nowTs + CORR_CACHE_TTL]);
      return corr;
    } catch (e) {
      logger.debug(`get_correlation ${symbolA}/${symbolB}: ${e && e.message}`);
      return null;
    }
  }

  async function checkCorrelationCap({ userId, newSymbol, newDirection, threshold = 0.7 }) {
    let symbols;
    try {
      const rows = dbOf().prepare("SELECT symbol FROM signal_trades WHERE user_id=? AND direction=? AND (result IS NULL OR result='')")
        .all(Number(userId), newDirection);
      symbols = rows.map((r) => r.symbol).filter((s) => s && s !== newSymbol);
    } catch (e) {
      logger.debug(`check_correlation_cap fetch open uid=${userId}: ${e && e.message}`);
      return { blocked: false, max_corr: 0.0, with_symbol: '', checked_count: 0 };
    }
    if (!symbols.length) return { blocked: false, max_corr: 0.0, with_symbol: '', checked_count: 0 };
    let maxCorr = 0.0;
    let maxWith = '';
    let checked = 0;
    for (const sym of symbols) {
      const corr = await getCorrelation(newSymbol, sym);
      if (corr === null) continue;
      checked += 1;
      const absCorr = Math.abs(corr);
      if (absCorr > maxCorr) { maxCorr = absCorr; maxWith = sym; }
    }
    const blocked = maxCorr >= threshold;
    const line = pf('[CORR-CAP] uid=%s new=%s dir=%s max_corr=%.3f with=%s thr=%.2f → %s', userId, newSymbol, newDirection, maxCorr, maxWith, threshold, blocked ? 'BLOCK' : 'PASS');
    if (blocked) logger.info(line); else logger.debug(line);
    return { blocked, max_corr: pyRound(maxCorr, 3), with_symbol: maxWith, checked_count: checked };
  }

  function gcCache() {
    const t = now();
    const stale = Array.from(corrCache.entries()).filter(([, [, exp]]) => exp < t).map(([k]) => k);
    for (const k of stale) corrCache.delete(k);
    return stale.length;
  }

  return { getCorrelation, checkCorrelationCap, gcCache, _cache: corrCache };
}

module.exports = { CORR_CACHE_TTL, LOOKBACK_BARS, MIN_BARS_FOR_CORR, createCorrelationCap, returnsSeries };
