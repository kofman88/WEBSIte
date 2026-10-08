'use strict';
/**
 * context.js — the context signals the LEVELS quality score consumes (spec §12):
 *
 *   btcEthCorrelation   `_btc_eth_correlation`: BTC/ETH close reindexed onto df.index
 *                       (method="nearest"), rolling(min(50, len−1)).corr, last value; labels
 *   divergenceCheck     `_divergence_check`: rolling(3) min/max of price and RSI, last vs previous
 *   htfConfluence       `_htf_confluence`: HTF close vs EMA(HTF_EMA_PERIOD) of the HTF frame
 *   lvnPath             `s_zone["lvn_checker"](entry, tp1)` — any LVN strictly between entry and TP1
 *
 * Pure; Frames + Float64Arrays in.
 */

const S = require('../common/series');

const CORR_LABEL = Object.freeze({
  DEFAULT: '〰️ Слабая корреляция',
  BOTH: '🔗 Ходит за BTC и ETH',
  BTC: '🔗 Ходит за BTC',
  ETH: '🔗 Ходит за ETH',
  INDEPENDENT: '🚀 Независимое движение',
  WEAK: '〰️ Слабая корреляция с рынком',
});

const DIVERGENCE = Object.freeze({ BULL: '✅ Бычья дивергенция RSI', BEAR: '✅ Медвежья дивергенция RSI' });

/**
 * `_btc_eth_correlation(df, df_btc, df_eth)` → { btc_corr, eth_corr, label }.
 * Defaults 0.5 / 0.5 / "〰️ Слабая корреляция"; a frame is used only when len > 10;
 * window = min(50, len(df) − 1) (< 10 → 0.5); NaN results are kept (comparisons are False).
 */
function btcEthCorrelation(df, dfBtc, dfEth) {
  const result = { btc_corr: 0.5, eth_corr: 0.5, label: CORR_LABEL.DEFAULT };

  const corr = (dfA, dfB) => {
    try {
      const bClose = S.reindexNearest(dfB.t, dfB.c, dfA.t);
      const window = Math.min(50, dfA.length - 1);
      if (window < 10) return 0.5;
      const rc = S.rollingCorr(dfA.c, bClose, window);
      return rc[rc.length - 1];
    } catch (_e) {
      return 0.5;
    }
  };

  if (dfBtc && dfBtc.length > 10) result.btc_corr = corr(df, dfBtc);
  if (dfEth && dfEth.length > 10) result.eth_corr = corr(df, dfEth);

  const bc = result.btc_corr;
  const ec = result.eth_corr;
  if (bc > 0.75 && ec > 0.75) result.label = CORR_LABEL.BOTH;
  else if (bc > 0.75) result.label = CORR_LABEL.BTC;
  else if (ec > 0.75) result.label = CORR_LABEL.ETH;
  else if (bc < 0.4 && ec < 0.4) result.label = CORR_LABEL.INDEPENDENT;
  else result.label = CORR_LABEL.WEAK;
  return result;
}

/**
 * `_divergence_check(df, rsi_series, direction)` → [ok, label]. Needs ≥ 20 bars.
 * LONG: lower low in price (rolling-3 min) with a higher low in RSI; SHORT (any other
 * direction string): higher high in price with a lower high in RSI. NaN → false.
 */
function divergenceCheck(df, rsi, direction) {
  if (df.length < 20) return [false, ''];
  try {
    const n = df.length;
    if (direction === 'LONG') {
      const pLo = S.rollingMin(df.l, 3);
      const rLo = S.rollingMin(rsi, 3);
      if (pLo[n - 1] < pLo[n - 2] && rLo[n - 1] > rLo[n - 2]) return [true, DIVERGENCE.BULL];
    } else {
      const pHi = S.rollingMax(df.h, 3);
      const rHi = S.rollingMax(rsi, 3);
      if (pHi[n - 1] > pHi[n - 2] && rHi[n - 1] < rHi[n - 2]) return [true, DIVERGENCE.BEAR];
    }
  } catch (_e) {
    // log.debug in the bot
  }
  return [false, ''];
}

/**
 * `_htf_confluence(df_htf, direction)`: false without a frame or with fewer than
 * HTF_EMA_PERIOD bars; LONG ok when close[-1] > EMA(close, period)[-1], SHORT when <.
 */
function htfConfluence(dfHtf, direction, htfEmaPeriod) {
  if (!dfHtf || dfHtf.length < htfEmaPeriod) return false;
  const n = dfHtf.length;
  const ema = S.ewmSpan(dfHtf.c, htfEmaPeriod);
  const htfEma = ema[n - 1];
  const htfPrice = dfHtf.c[n - 1];
  if (direction === 'LONG') return htfPrice > htfEma;
  return htfPrice < htfEma;
}

/** `has_lvn_path`: s_zone.lvn_checker(entry, tp1) when the zone carries the checker; errors → false. */
function lvnPath(sZone, entry, tp1) {
  if (!sZone || !('lvn_checker' in sZone) || typeof sZone.lvn_checker !== 'function') return false;
  try {
    return Boolean(sZone.lvn_checker(entry, tp1));
  } catch (_e) {
    return false;
  }
}

module.exports = { CORR_LABEL, DIVERGENCE, btcEthCorrelation, divergenceCheck, htfConfluence, lvnPath };
