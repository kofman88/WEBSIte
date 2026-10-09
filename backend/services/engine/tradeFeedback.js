'use strict';
/**
 * tradeFeedback.js — the bot's trade_feedback producer (trade_feedback.py record_feedback +
 * _map_result_for_ml, and the "SELF-LEARNING FIX #1" block of db/trades.py db_set_trade_result
 * that calls it). Every real result transition (the UPDATE matched, result not '' / SKIP) writes
 * one `trade_feedback` row per (user_id, trade_id) — INSERT OR REPLACE — with the ML label
 * (WIN / LOSS / SKIP), the pnl in R and the 9 ML features + analytics fields as JSON:
 *
 *   rr = |tp1 − entry| / |entry − sl| (3 dp), risk_pct / tp_pct (% of entry, 4 dp), direction_enc,
 *   quality (int(quality or 3)), session_hour (UTC hour of the write), regime_enc (_REGIME_MAP of the
 *   cached BTC regime), vol_ratio / atr_pct / rr_target / tf (keys the trades row does not have →
 *   1.0 / 0.02 / 0.0 / ''), exchange, raw_result.
 *
 * The consumer side (signal_filter ML, optimizer) arrives with D11; this module keeps the table the
 * bot keeps. Errors never propagate: the building block logs at debug (the bot's
 * `except Exception: log.debug("auto record_feedback failed …")`), the insert at warning.
 * The regime is market_regime.get_cached_regime(): the regime loop of this thread (engine worker)
 * or, on the HTTP thread, the worker's regime forwarded with its heartbeats (services/genome/regime).
 */

const { pyFloat, pyInt } = require('./pycoerce');
const { pyRound } = require('../../strategies/common/pyround');
const { pyUpper, pyLower } = require('../../strategies/common/pyUnicode');
const { pyJsonDumps } = require('./pyjson');

const REGIME_MAP = Object.freeze({ ranging: 0, trending_up: 1, trending_down: 2, high_vol: 3 });
const FEATURE_FLOATS = Object.freeze(['rr', 'risk_pct', 'tp_pct', 'vol_ratio', 'atr_pct', 'rr_target']);

const falsy = (v) => v === null || v === undefined || v === false || v === 0 || v === '';
/** trade.get(k) on a signal_trades row (a missing column is None). */
const get = (t, k) => (t && Object.prototype.hasOwnProperty.call(t, k) && t[k] !== undefined ? t[k] : null);
const floatOr = (v, d) => (falsy(v) ? d : pyFloat(v));
const strOr = (v, d) => (falsy(v) ? d : String(v));

/** _map_result_for_ml(raw_result, pnl_pct) */
function mapResultForMl(rawResult, pnlPct = 0.0) {
  if (falsy(rawResult)) return 'SKIP';
  const r = pyUpper(String(rawResult));
  if (['TP1', 'TP2', 'TP3', 'WIN'].includes(r)) return 'WIN';
  if (r === 'SL' || r === 'LOSS') return 'LOSS';
  if (r === 'MANUAL') {
    let v;
    try { v = floatOr(pnlPct, 0); } catch (_e) { v = 0.0; }
    if (v > 0.1) return 'WIN';
    if (v < -0.1) return 'LOSS';
    return 'SKIP';
  }
  return 'SKIP';
}

/** market_regime.get_cached_regime() of this thread (null when unknown). */
function cachedRegime() {
  try {
    const own = require('./regimeLoop').getCachedRegime();
    if (own !== null && own !== undefined) return own;
  } catch (_e) { /* no loop */ }
  try { return require('../genome/regime').getCachedRegime(); } catch (_e) { return null; }
}

/**
 * record_feedback(**kw) → INSERT OR REPLACE INTO trade_feedback; the features as json.dumps
 * (ensure_ascii, float repr), raw_result appended last (features.setdefault).
 */
function recordFeedback(db, kw, { now, log } = {}) {
  try {
    const ml = mapResultForMl(kw.result, kw.pnl_pct);
    const features = { ...(kw.features || {}) };
    if (!Object.prototype.hasOwnProperty.call(features, 'raw_result')) features.raw_result = kw.result;
    db.prepare(`INSERT OR REPLACE INTO trade_feedback
      (user_id, trade_id, symbol, strategy, direction, entry, sl, tp1, result, pnl_pct, regime, features, ts)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(kw.user_id, kw.trade_id, kw.symbol, kw.strategy, kw.direction, kw.entry, kw.sl, kw.tp1, ml, kw.pnl_pct,
        kw.regime, pyJsonDumps(features, FEATURE_FLOATS), now());
  } catch (e) {
    if (log) log.warning(`record_feedback uid=${kw.user_id} trade=${kw.trade_id}: ${e && e.message}`);
  }
}

/**
 * The db_set_trade_result block: the feedback of `trade` (the row after the write) for `result` /
 * `resultRr`. Throws where the bot's block raises (float('12,5') entry, int('abc') quality) — the
 * caller swallows it like the bot's `except Exception`.
 */
function feedbackOf(trade, tradeId, result, resultRr, { regime = null, now }) {
  const reg = falsy(regime) ? '' : regime;
  const entry = floatOr(get(trade, 'entry'), 0);
  const sl = floatOr(get(trade, 'sl'), 0);
  const tp1 = floatOr(get(trade, 'tp1'), 0);
  const dir = pyUpper(strOr(get(trade, 'direction'), 'LONG'));
  const riskDist = entry > 0 ? Math.abs(entry - sl) : 0.0;
  const tpDist = entry > 0 ? Math.abs(tp1 - entry) : 0.0;
  const rr = riskDist > 0 ? tpDist / riskDist : 0.0;
  const q = get(trade, 'quality');
  return {
    user_id: falsy(get(trade, 'user_id')) ? 0 : pyInt(get(trade, 'user_id')),
    trade_id: String(tradeId),
    symbol: strOr(get(trade, 'symbol'), ''),
    strategy: pyUpper(strOr(get(trade, 'strategy'), 'LEVELS')),
    direction: dir,
    entry, sl, tp1,
    result,
    pnl_pct: floatOr(resultRr, 0),
    regime: String(reg),
    features: {
      rr: pyRound(rr, 3),
      risk_pct: entry > 0 ? pyRound(riskDist / entry * 100, 4) : 0.0,
      tp_pct: entry > 0 ? pyRound(tpDist / entry * 100, 4) : 0.0,
      direction_enc: dir === 'LONG' ? 0 : 1,
      quality: falsy(q) ? 3 : pyInt(q),
      session_hour: new Date(now() * 1000).getUTCHours(),     // datetime.utcnow().hour
      regime_enc: Object.prototype.hasOwnProperty.call(REGIME_MAP, pyLower(String(reg))) ? REGIME_MAP[pyLower(String(reg))] : 0,
      vol_ratio: floatOr(get(trade, 'vol_ratio'), 1.0),
      atr_pct: floatOr(get(trade, 'atr_pct'), 0.02),
      rr_target: floatOr(get(trade, 'rr_target'), 0),
      exchange: strOr(get(trade, 'exchange'), ''),
      tf: strOr(get(trade, 'tf'), ''),
    },
  };
}

/** signalTradesRepo's default onClosed: the bot's record after a real result transition. */
function recordFromTrade(db, trade, tradeId, result, resultRr, { regime, now, log }) {
  let kw;
  try {
    kw = feedbackOf(trade, tradeId, result, resultRr, { regime: regime === undefined ? cachedRegime() : regime, now });
  } catch (e) {
    if (log) log.debug(`auto record_feedback failed trade=${tradeId}: ${e && e.message}`);
    return false;
  }
  recordFeedback(db, kw, { now, log });
  return true;
}

module.exports = { REGIME_MAP, FEATURE_FLOATS, mapResultForMl, cachedRegime, recordFeedback, feedbackOf, recordFromTrade };
