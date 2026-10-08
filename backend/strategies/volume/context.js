'use strict';
/**
 * context.js — VolumeContext: every indicator of the VOLUME strategy computed once over
 * the whole frame (volume_strategy.VolumeContext / prepare_context; spec §4).
 *
 *   maF/maM/maS/turn  SMA (rolling, min_periods=n) or EMA (ma_type="ema") of close
 *   e50/e200          EMA adjust=True of close (ema_mid / ema_trend)
 *   rsi               Wilder RSI (ewm alpha=1/n, adjust=False), NaN → 50
 *   atr               Wilder ATR of the true range; tr = true range per bar
 *   rib               8 ribbon EMAs (RIBBON_SPANS) — only when setup_ribbon
 *   vavg              volume.shift(1).rolling(vol_len).mean()  (signal bar EXCLUDED)
 *   vr                v / vavg where vavg > 0 else 0, NaN → 0
 *   htf / htfTf       per-bar HTF state (Int8Array or null) and the HTF label ("4h")
 *
 * All columns are Float64Arrays aligned with the frame; the OHLCV columns are the
 * frame's own (zero-copy).
 */

const S = require('../common/series');
const { VolumeConfig, RIBBON_SPANS, GOLDEN_VOL_MIN } = require('./config');

function ma(close, n, kind) {
  return kind === 'ema' ? S.ewmSpanAdjust(close, n) : S.sma(close, n);
}

class VolumeContext {
  constructor(df, cfg, htfStates = null, htfTf = '') {
    this.cfg = cfg;
    this.n = df.length;
    const close = df.c;
    this.c = close;
    this.o = df.o;
    this.h = df.h;
    this.l = df.l;
    this.v = df.v;
    this.maF = ma(close, cfg.ma_fast, cfg.ma_type);
    this.maM = ma(close, cfg.ma_mid, cfg.ma_type);
    this.maS = ma(close, cfg.ma_slow, cfg.ma_type);
    this.turn = ma(close, cfg.turn_period, cfg.ma_type);
    this.e50 = S.ewmSpanAdjust(close, cfg.ema_mid);
    this.e200 = S.ewmSpanAdjust(close, cfg.ema_trend);
    this.rsi = S.rsiWilder(close, cfg.rsi_period);
    this.atr = S.atrWilder(df.h, df.l, close, cfg.atr_period);
    // [VOL-SL-VOLATILITY] true range of every bar — "effective" stop volatility
    this.tr = S.trueRange(df.h, df.l, close);
    // [VOLUME-RIBBON] ribbon EMAs (rows = spans ascending); only when the setup is on
    this.rib = cfg.setup_ribbon ? RIBBON_SPANS.map((n) => S.ewmSpanAdjust(close, n)) : null;
    // volume SMA without the signal bar (otherwise a spike averages itself)
    this.vavg = S.volumeAvgExcludingLast(df.v, cfg.vol_len);
    const n = this.n;
    const vr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const va = this.vavg[i];
      let r = va > 0 ? df.v[i] / va : 0.0;          // np.where(vavg > 0, v / vavg, 0.0)
      if (r !== r) r = 0.0;                          // np.nan_to_num(nan=0.0)
      // QUIRK(spec §4.5): nan_to_num also maps ±inf to ±max float (unreachable with vavg > 0 finite)
      else if (r === Infinity) r = Number.MAX_VALUE;
      else if (r === -Infinity) r = -Number.MAX_VALUE;
      vr[i] = r;
    }
    this.vr = vr;
    this.htf = htfStates;
    this.htfTf = htfTf;
  }

  /** Cheap superset of the bars where a signal is possible (by volume ratio). Backtest pre-filter. */
  candidateMask() {
    const cfg = this.cfg;
    const th = [];
    if (cfg.setup_cross || cfg.setup_turn) th.push(cfg.vol_mult);
    if (cfg.setup_bounce) th.push(cfg.bounce_vol_mult);
    if (cfg.setup_golden) th.push(GOLDEN_VOL_MIN);
    if (cfg.setup_ribbon) th.push(cfg.ribbon_vol_mult);
    const out = new Uint8Array(this.n);
    if (!th.length) return out;
    const thr = Math.min(...th) - 1e-9;
    for (let i = 0; i < this.n; i++) out[i] = this.vr[i] >= thr ? 1 : 0;
    return out;
  }
}

function prepareContext(df, cfg = null, htfStates = null, htfTf = '') {
  return new VolumeContext(df, cfg || new VolumeConfig(), htfStates, htfTf);
}

module.exports = { VolumeContext, prepareContext };
