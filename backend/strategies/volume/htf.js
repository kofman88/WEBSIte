'use strict';
/**
 * htf.js — higher-timeframe state of the VOLUME strategy (volume_strategy.py:
 * htf_for, _htf_state_arrays, htf_state, resample_htf, htf_state_series; spec §5).
 *
 * State per HTF bar: side = sign(close − EMA), slope = sign(EMA_t − EMA_{t−3}) (0 for
 * t < 3), strong = side ≠ 0 and slope == side; state = side × (strong ? 2 : 1).
 * The EMA is pandas ewm(span=htf_ema, adjust=True, min_periods=1).
 */

const S = require('../common/series');
const { Frame, TF_MS, resample } = require('../common/frame');
const { HTF_SLOPE_BARS } = require('./config');
const { pyLower } = require('../common/pyUnicode');   // CPython 3.11 str case / whitespace methods

/** Higher timeframe for the confirmation filter. */
const HTF_MAP = Object.freeze({ '15m': '1h', '1h': '4h', '4h': '1d' });
/** pandas Timedelta of a timeframe (ms). */
const TF_DELTA_MS = Object.freeze({ '15m': TF_MS['15m'], '1h': TF_MS['1h'], '4h': TF_MS['4h'], '1d': TF_MS['1d'] });
/** pandas resample rule per HTF ("1h", "4h", "1D") — all divide a UTC day. */
const RESAMPLE_RULE = Object.freeze({ '1h': '1h', '4h': '4h', '1d': '1D' });

/** `HTF_MAP.get((timeframe or "").lower(), "")` */
function htfFor(timeframe) {
  return HTF_MAP[pyLower(String(timeframe || ''))] || '';
}

/**
 * `_htf_state_arrays(close, ema)`: ±2 (price side of the EMA + EMA slope with it), ±1
 * (side only), 0 (price exactly on the EMA / non-finite). Returns an Int8Array.
 */
function htfStateArrays(close, ema) {
  const c = S.toF64(close), e = S.toF64(ema);
  const n = c.length;
  const out = new Int8Array(n);
  for (let t = 0; t < n; t++) {
    const side = Math.sign(c[t] - e[t]);
    const prev = t >= HTF_SLOPE_BARS ? e[t - HTF_SLOPE_BARS] : Number.NaN;   // prev[:3] = NaN
    let d = e[t] - prev;
    if (d !== d) d = 0.0;                                                      // np.nan_to_num(nan=0.0)
    const slope = Math.sign(d);
    const strong = side !== 0 && slope === side;
    // QUIRK(spec §5.1): a NaN side (non-finite close/EMA) becomes 0 through the int8 cast.
    out[t] = side !== side ? 0 : side * (strong ? 2 : 1);
  }
  return out;
}

/**
 * `htf_state(df_htf, cfg)`: state of the LAST HTF row, 0 when df_htf is missing or
 * shorter than htf_ema // 2 + 3 + 1 rows (29 for the default 50).
 */
function htfState(dfHtf, cfg) {
  if (!dfHtf || dfHtf.length < Math.floor(cfg.htf_ema / 2) + HTF_SLOPE_BARS + 1) return 0;
  const e = S.ewmSpanAdjust(dfHtf.c, cfg.htf_ema);
  const st = htfStateArrays(dfHtf.c, e);
  return st[st.length - 1];
}

/** Rows with a NaN in any OHLCV column dropped (pandas `.dropna()` after the aggregation). */
function dropNaRows(frame) {
  const keep = [];
  for (let i = 0; i < frame.length; i++) {
    const r = frame.row(i);
    if (r.o === r.o && r.h === r.h && r.l === r.l && r.c === r.c && r.v === r.v) keep.push(i);
  }
  if (keep.length === frame.length) return frame;
  const pick = (arr) => Float64Array.from(keep, (i) => arr[i]);
  const f = new Frame(pick(frame.t), pick(frame.o), pick(frame.h), pick(frame.l), pick(frame.c), pick(frame.v));
  f.symbol = frame.symbol;
  return f;
}

/**
 * `resample_htf(df, timeframe)`: HTF candles built from the LTF frame (pandas resample
 * label="left", closed="left", origin=start_day; open=first, high=max, low=min,
 * close=last, volume=sum), keeping only buckets fully closed at the last LTF close
 * (`bucket_open + Δ_htf <= last_ltf_open + Δ_ltf`). The FIRST bucket may be partial
 * (QUIRK(spec §5.3): only the trailing cut is enforced). null when nothing is left.
 */
function resampleHtf(df, timeframe) {
  const htf = htfFor(timeframe);
  const rule = RESAMPLE_RULE[htf];
  const ltfD = TF_DELTA_MS[pyLower(String(timeframe || ''))];
  if (!rule || ltfD === undefined || !df || df.length === 0) return null;
  const agg = dropNaRows(resample(df, TF_MS[htf]));
  const htfD = TF_DELTA_MS[htf];
  const lastClose = df.t[df.length - 1] + ltfD;
  const n = agg.countClosedAt(htfD, lastClose);
  return n ? agg.slice(0, n) : null;
}

/** Bucket close times of a close-only resample (`agg.index + Δ_htf`) and the closes. */
function resampleClose(df, htfMs) {
  const n = df.length;
  const t = [], c = [];
  let i = 0;
  while (i < n) {
    const bucket = Math.floor(df.t[i] / htfMs) * htfMs;
    let j = i;
    let lastC = Number.NaN;
    while (j < n && Math.floor(df.t[j] / htfMs) * htfMs === bucket) {
      if (df.c[j] === df.c[j]) lastC = df.c[j];      // GroupBy.last skips NaN
      j++;
    }
    if (lastC === lastC) { t.push(bucket); c.push(lastC); }   // dropna
    i = j;
  }
  return { t: Float64Array.from(t), c: Float64Array.from(c) };
}

/** np.searchsorted(a, v, side="right") on an ascending Float64Array. */
function searchsortedRight(a, v) {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] <= v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * `htf_state_series(df, timeframe, cfg)` (backtests): the HTF state at the close of every
 * LTF bar, built by resampling the LTF frame itself (close only, ≥ 3 buckets). For each
 * LTF bar the last HTF bucket whose close time ≤ the LTF close time is used; the state
 * counts only once that bucket index ≥ htf_ema // 2 (else 0). No look-ahead. null when
 * the timeframe is unknown or there are fewer than 3 buckets.
 */
function htfStateSeries(df, timeframe, cfg) {
  const htf = htfFor(timeframe);
  const rule = RESAMPLE_RULE[htf];
  const ltfD = TF_DELTA_MS[pyLower(String(timeframe || ''))];
  if (!rule || ltfD === undefined || !df) return null;
  const agg = resampleClose(df, TF_MS[htf]);
  if (agg.c.length < 3) return null;
  const st = htfStateArrays(agg.c, S.ewmSpanAdjust(agg.c, cfg.htf_ema));
  const htfD = TF_DELTA_MS[htf];
  const htfCloseT = Float64Array.from(agg.t, (b) => b + htfD);
  const out = new Int8Array(df.length);
  const minIdx = Math.max(0, Math.floor(cfg.htf_ema / 2));
  for (let i = 0; i < df.length; i++) {
    const pos = searchsortedRight(htfCloseT, df.t[i] + ltfD) - 1;
    out[i] = pos >= minIdx ? st[pos] : 0;
  }
  return out;
}

module.exports = {
  HTF_MAP, TF_DELTA_MS, RESAMPLE_RULE, htfFor, htfStateArrays, htfState, resampleHtf, htfStateSeries,
  searchsortedRight,
};
