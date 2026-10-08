'use strict';
/**
 * series.js — pure numeric primitives reproducing pandas 2.3.3 / numpy 1.26.4
 * float64 semantics BIT-FOR-BIT (same operation order, same NaN rules).
 *
 * Every function takes number[] / Float64Array and returns a Float64Array (or a
 * number). NaN is the only "missing" marker, exactly like pandas float64 Series.
 *
 * Sources of truth (read from the installed packages / tagged sources):
 *   pandas/_libs/window/aggregations.pyx  — ewm, roll_mean, roll_sum, roll_var
 *   pandas/core/window/rolling.py          — Rolling.corr formula
 *   pandas/core/window/ewm.py              — span/alpha → center of mass
 *   pandas/core/array_algos/quantile.py    — Series.quantile → np.percentile(q*100)
 *   numpy/lib/function_base.py             — _quantile linear / _lerp / linspace
 *   numpy/core/src/umath/loops_utils.h.src — pairwise summation (add.reduce)
 *   numpy/core/_methods.py                 — _mean / _var
 *
 * Which strategy uses what (see docs/port specs):
 *   LEVELS: ewmSpan (EMA/RSI/ATR, adjust=False), rollingMean, rollingMin/Max,
 *           rollingCorr, reindexNearest, npStd (KDE bandwidth), npMean.
 *   SMC   : ewmSpan (ATR span 14), seriesMean (vol avg), rollingMean/rollingStd
 *           ddof=0 + seriesQuantile (squeeze detector).
 *   VOLUME: ewmSpanAdjust (EMA adjust=True, min_periods=1), ewmAlpha (Wilder
 *           RSI/ATR alpha=1/n), sma (min_periods=n), rollingMean of shifted volume.
 */

const NaN_ = Number.NaN;

function toF64(x) {
  if (x instanceof Float64Array) return x;
  return Float64Array.from(x, Number);
}

// ─────────────────────────────────────────────────────────────────────────────
// numpy reductions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * numpy pairwise summation (DOUBLE_pairwise_sum): blocks < 8 sequential, blocks
 * ≤ 128 use 8 interleaved accumulators, larger blocks split in two (n/2 rounded
 * down to a multiple of 8).
 */
function pairwiseSum(a, lo, hi) {
  const n = hi - lo;
  if (n < 8) {
    let res = 0.0;
    for (let i = lo; i < hi; i++) res += a[i];
    return res;
  }
  if (n <= 128) {
    let r0 = a[lo], r1 = a[lo + 1], r2 = a[lo + 2], r3 = a[lo + 3];
    let r4 = a[lo + 4], r5 = a[lo + 5], r6 = a[lo + 6], r7 = a[lo + 7];
    let i = 8;
    const lim = n - (n % 8);
    for (; i < lim; i += 8) {
      const b = lo + i;
      r0 += a[b]; r1 += a[b + 1]; r2 += a[b + 2]; r3 += a[b + 3];
      r4 += a[b + 4]; r5 += a[b + 5]; r6 += a[b + 6]; r7 += a[b + 7];
    }
    let res = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7));
    for (; i < n; i++) res += a[lo + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwiseSum(a, lo, lo + n2) + pairwiseSum(a, lo + n2, hi);
}

/** np.sum / ndarray.sum of a contiguous float64 vector (identity 0.0 + pairwise). */
function npSum(x) {
  const a = toF64(x);
  return 0.0 + pairwiseSum(a, 0, a.length);
}

/** np.mean (numpy _mean: sum / count). Empty → NaN. */
function npMean(x) {
  const a = toF64(x);
  return npSum(a) / a.length;
}

/** np.var(ddof) (numpy _var: mean, squared deviations, pairwise sum / (n-ddof)). */
function npVar(x, ddof = 0) {
  const a = toF64(x);
  const n = a.length;
  const mean = npSum(a) / n;
  const sq = new Float64Array(n);
  for (let i = 0; i < n; i++) { const d = a[i] - mean; sq[i] = d * d; }
  const div = Math.max(n - ddof, 0);
  return npSum(sq) / div;
}

/** np.std(ddof) = sqrt(np.var). numpy default ddof=0. */
function npStd(x, ddof = 0) {
  return Math.sqrt(npVar(x, ddof));
}

/** pandas Series.mean() (nanops.nanmean): NaN → 0 before the pairwise sum, divided by the non-NaN count. */
function seriesMean(x) {
  const a = toF64(x);
  const n = a.length;
  const filled = new Float64Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const v = a[i];
    if (v === v) { filled[i] = v; count++; } else filled[i] = 0.0;
  }
  if (count === 0) return NaN_;
  return npSum(filled) / count;
}

/** pandas Series.min()/max() (NaN skipped; all-NaN → NaN). */
function seriesMin(x) {
  const a = toF64(x);
  let m = NaN_;
  for (let i = 0; i < a.length; i++) { const v = a[i]; if (v === v && !(v >= m)) m = v; }
  return m;
}
function seriesMax(x) {
  const a = toF64(x);
  let m = NaN_;
  for (let i = 0; i < a.length; i++) { const v = a[i]; if (v === v && !(v <= m)) m = v; }
  return m;
}

/** Python builtin sum() over floats: sequential left-to-right starting at 0. */
function seqSum(x) {
  const a = toF64(x);
  let s = 0.0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

/** Kahan–Babuska compensated sum as used by pandas groupby/resample "sum" (group_sum). NaN skipped. */
function kahanSum(x) {
  const a = toF64(x);
  let sum = 0.0, comp = 0.0;
  for (let i = 0; i < a.length; i++) {
    const val = a[i];
    if (val !== val) continue;
    const y = val - comp;
    const t = sum + y;
    comp = t - sum - y;
    if (comp !== comp) comp = 0; // GH#53606 (±inf)
    sum = t;
  }
  return sum;
}

// ─────────────────────────────────────────────────────────────────────────────
// elementwise helpers (pandas Series arithmetic)
// ─────────────────────────────────────────────────────────────────────────────

/** Series.shift(n): leading NaNs (n>0) or trailing NaNs (n<0). */
function shift(x, periods = 1) {
  const a = toF64(x);
  const n = a.length;
  const out = new Float64Array(n);
  out.fill(NaN_);
  if (periods >= 0) {
    for (let i = periods; i < n; i++) out[i] = a[i - periods];
  } else {
    for (let i = 0; i < n + periods; i++) out[i] = a[i - periods];
  }
  return out;
}

/** Series.diff(periods): x[i] − x[i−periods], NaN prefix. */
function diff(x, periods = 1) {
  const a = toF64(x);
  const n = a.length;
  const out = new Float64Array(n);
  out.fill(NaN_);
  for (let i = periods; i < n; i++) out[i] = a[i] - a[i - periods];
  return out;
}

/** Series.ffill(): forward-fill interior NaNs (leading NaNs stay). */
function ffill(x) {
  const a = toF64(x);
  const out = new Float64Array(a.length);
  let last = NaN_;
  for (let i = 0; i < a.length; i++) { const v = a[i]; if (v === v) last = v; out[i] = last; }
  return out;
}

/**
 * Series.pct_change(periods) — pandas 2.3.3 default fill_method='pad':
 * data = ffill(x); data / data.shift(periods) − 1. Pass fill=null for fill_method=None.
 */
function pctChange(x, periods = 1, fill = 'pad') {
  const a = fill === 'pad' ? ffill(x) : toF64(x);
  const n = a.length;
  const out = new Float64Array(n);
  out.fill(NaN_);
  for (let i = periods; i < n; i++) out[i] = a[i] / a[i - periods] - 1;
  return out;
}

/** Series.clip(lower=lo): values < lo → lo; NaN stays NaN. */
function clipLower(x, lo) {
  const a = toF64(x);
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) { const v = a[i]; out[i] = (v !== v || v >= lo) ? v : lo; }
  return out;
}

/** Series.clip(upper=hi): values > hi → hi; NaN stays NaN. */
function clipUpper(x, hi) {
  const a = toF64(x);
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) { const v = a[i]; out[i] = (v !== v || v <= hi) ? v : hi; }
  return out;
}

/** −Series (keeps −0.0 semantics: −(0.0) = −0.0 like numpy). */
function neg(x) {
  const a = toF64(x);
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = -a[i];
  return out;
}

function abs(x) {
  const a = toF64(x);
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.abs(a[i]);
  return out;
}

/** Series.fillna(v). */
function fillna(x, v) {
  const a = toF64(x);
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) { const t = a[i]; out[i] = t === t ? t : v; }
  return out;
}

/** Series.replace(0, NaN) (−0.0 == 0 → replaced too). */
function replaceZeroNaN(x) {
  const a = toF64(x);
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) { const t = a[i]; out[i] = t === 0 ? NaN_ : t; }
  return out;
}

/** numpy cumsum (sequential; NaN propagates like numpy). */
function cumsum(x) {
  const a = toF64(x);
  const out = new Float64Array(a.length);
  let s = 0.0;
  for (let i = 0; i < a.length; i++) { s += a[i]; out[i] = s; }
  return out;
}

/** pandas Series.cumsum() (skipna=True: NaN positions stay NaN, the running sum continues). */
function seriesCumsum(x) {
  const a = toF64(x);
  const out = new Float64Array(a.length);
  let s = 0.0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v !== v) { out[i] = NaN_; continue; }
    s += v; out[i] = s;
  }
  return out;
}

/** numpy cummax / cummin (NaN propagates). */
function cummax(x) {
  const a = toF64(x);
  const out = new Float64Array(a.length);
  let m = -Infinity;
  for (let i = 0; i < a.length; i++) { const v = a[i]; if (v !== v) m = NaN_; else if (m === m && v > m) m = v; out[i] = m; }
  return out;
}
function cummin(x) {
  const a = toF64(x);
  const out = new Float64Array(a.length);
  let m = Infinity;
  for (let i = 0; i < a.length; i++) { const v = a[i]; if (v !== v) m = NaN_; else if (m === m && v < m) m = v; out[i] = m; }
  return out;
}

/** np.linspace(start, stop, num) with endpoint=True. */
function linspace(start, stop, num) {
  const out = new Float64Array(num);
  if (num === 0) return out;
  const div = num - 1;
  const delta = stop - start;
  if (div > 0) {
    const step = delta / div;
    if (step === 0) {
      for (let i = 0; i < num; i++) out[i] = (i / div) * delta + start;
    } else {
      for (let i = 0; i < num; i++) out[i] = i * step + start;
    }
    out[num - 1] = stop;
  } else {
    out[0] = 0 * delta + start;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exponentially weighted mean — pandas aggregations.pyx::ewm (normalize=True,
// ignore_na=False, min_periods → max(min_periods, 1)).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Core EWM over a center-of-mass. Leading NaNs are skipped (the first observation
 * seeds the mean); an interior NaN decays the old weight but leaves the value.
 */
function ewmCom(x, com, adjust, minPeriods = 1) {
  const vals = toF64(x);
  const N = vals.length;
  const out = new Float64Array(N);
  if (N === 0) return out;
  const minp = Math.max(minPeriods | 0, 1);
  const alpha = 1.0 / (1.0 + com);
  const oldWtFactor = 1.0 - alpha;
  const newWt = adjust ? 1.0 : alpha;

  let weighted = vals[0];
  let nobs = weighted === weighted ? 1 : 0;
  out[0] = nobs >= minp ? weighted : NaN_;
  let oldWt = 1.0;

  for (let i = 1; i < N; i++) {
    const cur = vals[i];
    const isObs = cur === cur;
    if (isObs) nobs++;
    if (weighted === weighted) {
      // ignore_na=False → the old weight always decays
      oldWt *= oldWtFactor;
      if (isObs) {
        // avoid numerical errors on constant series
        if (weighted !== cur) {
          weighted = oldWt * weighted + newWt * cur;
          weighted /= (oldWt + newWt);
        }
        if (adjust) oldWt += newWt; else oldWt = 1.0;
      }
    } else if (isObs) {
      weighted = cur;
    }
    out[i] = nobs >= minp ? weighted : NaN_;
  }
  return out;
}

/** s.ewm(span=n, adjust=False).mean()  — LEVELS/SMC EMA, RSI, ATR. */
function ewmSpan(x, span) {
  return ewmCom(x, (span - 1) / 2, false, 1);
}

/** s.ewm(span=n, adjust=True, min_periods=1).mean()  — VOLUME EMA (recursive weighted form of pandas). */
function ewmSpanAdjust(x, span, minPeriods = 1) {
  return ewmCom(x, (span - 1) / 2, true, minPeriods);
}

/** s.ewm(alpha=a, adjust=False).mean()  — Wilder smoothing when a = 1/n (VOLUME RSI/ATR). */
function ewmAlpha(x, alpha) {
  return ewmCom(x, (1 - alpha) / alpha, false, 1);
}

/** Wilder smoothing alias: ewm(alpha=1/n, adjust=False). */
function wilder(x, n) {
  return ewmAlpha(x, 1.0 / n);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rolling windows — pandas FixedWindowIndexer: start=max(0,i+1−n), end=i+1,
// state carried across windows exactly like the Cython add/remove loops.
// ─────────────────────────────────────────────────────────────────────────────

/** rolling(n, min_periods).mean() — aggregations.pyx::roll_mean (Kahan add/remove + same-value guard). */
function rollingMean(x, n, minPeriods = n) {
  const values = toF64(x);
  const N = values.length;
  const out = new Float64Array(N);
  const minp = minPeriods;
  let sumX = 0.0, compAdd = 0.0, compRemove = 0.0, prevValue = 0.0;
  let nobs = 0, negCt = 0, numSame = 0;
  let prevStart = 0, prevEnd = 0;
  for (let i = 0; i < N; i++) {
    const s = Math.max(0, i + 1 - n);
    const e = i + 1;
    if (i === 0 || s >= prevEnd) {
      compAdd = compRemove = sumX = 0.0;
      nobs = negCt = 0;
      prevValue = values[s];
      numSame = 0;
      for (let j = s; j < e; j++) {
        const val = values[j];
        if (val === val) {
          nobs++;
          const y = val - compAdd;
          const t = sumX + y;
          compAdd = t - sumX - y;
          sumX = t;
          if (val < 0 || Object.is(val, -0)) negCt++;
          if (val === prevValue) numSame++; else numSame = 1;
          prevValue = val;
        }
      }
    } else {
      for (let j = prevStart; j < s; j++) {
        const val = values[j];
        if (val === val) {
          nobs--;
          const y = -val - compRemove;
          const t = sumX + y;
          compRemove = t - sumX - y;
          sumX = t;
          if (val < 0 || Object.is(val, -0)) negCt--;
        }
      }
      for (let j = prevEnd; j < e; j++) {
        const val = values[j];
        if (val === val) {
          nobs++;
          const y = val - compAdd;
          const t = sumX + y;
          compAdd = t - sumX - y;
          sumX = t;
          if (val < 0 || Object.is(val, -0)) negCt++;
          if (val === prevValue) numSame++; else numSame = 1;
          prevValue = val;
        }
      }
    }
    // calc_mean
    let result;
    if (nobs >= minp && nobs > 0) {
      result = sumX / nobs;
      if (numSame >= nobs) result = prevValue;
      else if (negCt === 0 && result < 0) result = 0;
      else if (negCt === nobs && result > 0) result = 0;
    } else {
      result = NaN_;
    }
    out[i] = result;
    prevStart = s; prevEnd = e;
  }
  return out;
}

/** rolling(n, min_periods).sum() — aggregations.pyx::roll_sum. */
function rollingSum(x, n, minPeriods = n) {
  const values = toF64(x);
  const N = values.length;
  const out = new Float64Array(N);
  const minp = minPeriods;
  let sumX = 0.0, compAdd = 0.0, compRemove = 0.0, prevValue = 0.0;
  let nobs = 0, numSame = 0;
  let prevStart = 0, prevEnd = 0;
  for (let i = 0; i < N; i++) {
    const s = Math.max(0, i + 1 - n);
    const e = i + 1;
    if (i === 0 || s >= prevEnd) {
      prevValue = values[s];
      numSame = 0;
      sumX = compAdd = compRemove = 0.0;
      nobs = 0;
      for (let j = s; j < e; j++) {
        const val = values[j];
        if (val === val) {
          nobs++;
          const y = val - compAdd;
          const t = sumX + y;
          compAdd = t - sumX - y;
          sumX = t;
          if (val === prevValue) numSame++; else numSame = 1;
          prevValue = val;
        }
      }
    } else {
      for (let j = prevStart; j < s; j++) {
        const val = values[j];
        if (val === val) {
          nobs--;
          const y = -val - compRemove;
          const t = sumX + y;
          compRemove = t - sumX - y;
          sumX = t;
        }
      }
      for (let j = prevEnd; j < e; j++) {
        const val = values[j];
        if (val === val) {
          nobs++;
          const y = val - compAdd;
          const t = sumX + y;
          compAdd = t - sumX - y;
          sumX = t;
          if (val === prevValue) numSame++; else numSame = 1;
          prevValue = val;
        }
      }
    }
    // calc_sum
    let result;
    if (nobs === 0 && minp === 0) result = 0;
    else if (nobs >= minp) result = numSame >= nobs ? prevValue * nobs : sumX;
    else result = NaN_;
    out[i] = result;
    prevStart = s; prevEnd = e;
  }
  return out;
}

/** rolling(n, min_periods).var(ddof) — aggregations.pyx::roll_var (Welford + Kahan, deletes before adds). */
function rollingVar(x, n, ddof = 1, minPeriods = n) {
  const values = toF64(x);
  const N = values.length;
  const out = new Float64Array(N);
  const minp = Math.max(minPeriods, 1);
  let meanX = 0.0, ssqdmX = 0.0, nobs = 0.0, compAdd = 0.0, compRemove = 0.0, prevValue = 0.0;
  let numSame = 0;
  let prevStart = 0, prevEnd = 0;

  const addVar = (val) => {
    if (val !== val) return;
    nobs = nobs + 1;
    if (val === prevValue) numSame++; else numSame = 1;
    prevValue = val;
    const prevMean = meanX - compAdd;
    const y = val - compAdd;
    const t = y - meanX;
    compAdd = t + meanX - y;
    const delta = t;
    if (nobs) meanX = meanX + delta / nobs; else meanX = 0;
    ssqdmX = ssqdmX + (val - prevMean) * (val - meanX);
  };
  const removeVar = (val) => {
    if (val !== val) return;
    nobs = nobs - 1;
    if (nobs) {
      const prevMean = meanX - compRemove;
      const y = val - compRemove;
      const t = y - meanX;
      compRemove = t + meanX - y;
      const delta = t;
      meanX = meanX - delta / nobs;
      ssqdmX = ssqdmX - (val - prevMean) * (val - meanX);
    } else {
      meanX = 0;
      ssqdmX = 0;
    }
  };

  for (let i = 0; i < N; i++) {
    const s = Math.max(0, i + 1 - n);
    const e = i + 1;
    if (i === 0 || s >= prevEnd) {
      prevValue = values[s];
      numSame = 0;
      meanX = ssqdmX = nobs = compAdd = compRemove = 0;
      for (let j = s; j < e; j++) addVar(values[j]);
    } else {
      for (let j = prevStart; j < s; j++) removeVar(values[j]);
      for (let j = prevEnd; j < e; j++) addVar(values[j]);
    }
    // calc_var
    let result;
    if (nobs >= minp && nobs > ddof) {
      if (nobs === 1 || numSame >= nobs) result = 0;
      else result = ssqdmX / (nobs - ddof);
    } else {
      result = NaN_;
    }
    out[i] = result;
    prevStart = s; prevEnd = e;
  }
  return out;
}

/** rolling(n).std(ddof) = zsqrt(rolling var): negative variances → 0. */
function rollingStd(x, n, ddof = 1, minPeriods = n) {
  const v = rollingVar(x, n, ddof, minPeriods);
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] < 0 ? 0 : Math.sqrt(v[i]);
  return out;
}

/** rolling(n, min_periods).max() — exact (no float accumulation); NaN skipped. */
function rollingMax(x, n, minPeriods = n) {
  const a = toF64(x);
  const N = a.length;
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const s = Math.max(0, i + 1 - n);
    let m = -Infinity, nobs = 0;
    for (let j = s; j <= i; j++) { const v = a[j]; if (v === v) { nobs++; if (v > m) m = v; } }
    out[i] = nobs >= minPeriods && nobs > 0 ? m : NaN_;
  }
  return out;
}

/** rolling(n, min_periods).min() — exact; NaN skipped. */
function rollingMin(x, n, minPeriods = n) {
  const a = toF64(x);
  const N = a.length;
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const s = Math.max(0, i + 1 - n);
    let m = Infinity, nobs = 0;
    for (let j = s; j <= i; j++) { const v = a[j]; if (v === v) { nobs++; if (v < m) m = v; } }
    out[i] = nobs >= minPeriods && nobs > 0 ? m : NaN_;
  }
  return out;
}

/** VOLUME `_sma`: rolling(n, min_periods=n).mean(). */
function sma(x, n) {
  return rollingMean(x, n, n);
}

/**
 * x.rolling(n).corr(y) — pandas Rolling.corr (ddof=1):
 *   (mean(xy) − mean(x)·mean(y)) · (count/(count−1)) / sqrt(var(x)·var(y))
 * Zero variance → 0/0 = NaN (or ±Inf when the numerator is not exactly 0), exactly as pandas.
 */
function rollingCorr(x, y, n, minPeriods = n) {
  const x0 = toF64(x), y0 = toF64(y);
  const N = x0.length;
  if (y0.length !== N) throw new Error('rollingCorr: length mismatch');
  // pandas prep_binary: X = x + 0*y, Y = y + 0*x (a NaN/inf on either side masks both)
  const xa = new Float64Array(N), ya = new Float64Array(N);
  for (let i = 0; i < N; i++) { xa[i] = x0[i] + 0 * y0[i]; ya[i] = y0[i] + 0 * x0[i]; }
  const xy = new Float64Array(N);
  const notna = new Float64Array(N);
  for (let i = 0; i < N; i++) { xy[i] = xa[i] * ya[i]; const s = xa[i] + ya[i]; notna[i] = s === s ? 1 : 0; }
  const meanXY = rollingMean(xy, n, minPeriods);
  const meanX = rollingMean(xa, n, minPeriods);
  const meanY = rollingMean(ya, n, minPeriods);
  const count = rollingSum(notna, n, 0);
  const varX = rollingVar(xa, n, 1, minPeriods);
  const varY = rollingVar(ya, n, 1, minPeriods);
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const numerator = (meanXY[i] - meanX[i] * meanY[i]) * (count[i] / (count[i] - 1));
    const denominator = Math.sqrt(varX[i] * varY[i]); // numpy ** 0.5 → sqrt fast path
    out[i] = numerator / denominator;
  }
  return out;
}

/**
 * np.corrcoef(x, y)[0, 1] — Pearson on two equal-length vectors (ddof-free ratio).
 * The BLAS dot order of numpy cannot be reproduced exactly; sequential products are used.
 * Result clipped to [−1, 1] like numpy.
 */
function pearson(x, y) {
  const xa = toF64(x), ya = toF64(y);
  const n = xa.length;
  if (ya.length !== n || n === 0) return NaN_;
  // np.cov: avg = row means (pairwise), X -= avg, c = dot(X, X.T) * (1/(n-1))
  const mx = npSum(xa) / n, my = npSum(ya) / n;
  let sxy = 0.0, sxx = 0.0, syy = 0.0;
  for (let i = 0; i < n; i++) {
    const dx = xa[i] - mx, dy = ya[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  const inv = 1 / (n - 1);
  const c01 = sxy * inv, c00 = sxx * inv, c11 = syy * inv;
  // np.corrcoef: stddev = sqrt(diag); c /= stddev[:, None]; c /= stddev[None, :]; clip
  let c = c01 / Math.sqrt(c00) / Math.sqrt(c11);
  if (c > 1) c = 1; else if (c < -1) c = -1;
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quantiles (numpy linear = method 7)
// ─────────────────────────────────────────────────────────────────────────────

/** numpy _quantile(method='linear') on an already NaN-free array; q in [0,1] used as is. */
function quantileCore(values, q) {
  const n = values.length;
  if (n === 0) return NaN_;
  const srt = Float64Array.from(values).sort();
  const virtual = (n - 1) * q;
  if (!(virtual === virtual)) return NaN_;
  if (virtual >= n - 1) return srt[n - 1];
  let prev = Math.floor(virtual), next = prev + 1;
  if (virtual < 0) { prev = 0; next = 0; }
  const gamma = virtual - prev;
  const a = srt[prev], b = srt[next];
  const d = b - a;
  return gamma >= 0.5 ? b - d * (1 - gamma) : a + d * gamma;
}

/** np.quantile(values, q) (NaN-free input assumed; NaNs are dropped here for safety). */
function npQuantile(x, q) {
  const a = toF64(x);
  const clean = a.filter((v) => v === v);
  return quantileCore(clean, q);
}

/**
 * pandas Series.quantile(q, interpolation='linear'): NaNs dropped, and q goes
 * through np.percentile(q*100) → true_divide(.., 100) first (q = (q*100)/100).
 */
function seriesQuantile(x, q) {
  const a = toF64(x);
  const clean = a.filter((v) => v === v);
  const qq = (q * 100.0) / 100;
  return quantileCore(clean, qq);
}

// ─────────────────────────────────────────────────────────────────────────────
// Indicator building blocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True range per bar: max(h−l, |h−prev_close|, |l−prev_close|) with the pandas
 * DataFrame.max(axis=1) NaN rule → row 0 (no previous close) = h−l.
 * The three bot variants (pd.concat(...).max(axis=1), Series.combine(max), the
 * same with .shift(1)) all yield h−l on the first row, so one function suffices.
 */
function trueRange(high, low, close) {
  const h = toF64(high), l = toF64(low), c = toF64(close);
  const n = h.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const hl = h[i] - l[i];
    if (i === 0) { out[i] = hl; continue; }
    const pc = c[i - 1];
    const a = Math.abs(h[i] - pc), b = Math.abs(l[i] - pc);
    let m = hl;
    if (a === a && !(a <= m)) m = a;
    if (b === b && !(b <= m)) m = b;
    if (m !== m) { // hl NaN: fall back to the others (pandas skipna)
      m = a === a ? (b === b && b > a ? b : a) : b;
    }
    out[i] = m;
  }
  return out;
}

/** LEVELS/SMC/market_regime ATR: ewm(span=n, adjust=False) of TR. */
function atrEmaSpan(high, low, close, n) {
  return ewmSpan(trueRange(high, low, close), n);
}

/** VOLUME ATR: ewm(alpha=1/n, adjust=False) of TR (Wilder). */
function atrWilder(high, low, close, n) {
  return ewmAlpha(trueRange(high, low, close), 1.0 / n);
}

/** squeeze_detector ATR: rolling(n).mean() of TR. */
function atrSma(high, low, close, n) {
  return rollingMean(trueRange(high, low, close), n, n);
}

/**
 * LEVELS RSI: gains/losses from diff(), both smoothed with ewm(span=n, adjust=False),
 * rs = g / ls.replace(0, NaN) → 100 − 100/(1+rs). Zero-loss windows → NaN (kept).
 */
function rsiSpan(close, n = 14) {
  const d = diff(close, 1);
  const g = ewmSpan(clipLower(d, 0), n);
  const ls = ewmSpan(neg(clipUpper(d, 0)), n);
  const out = new Float64Array(d.length);
  for (let i = 0; i < d.length; i++) {
    const l = ls[i];
    const rs = g[i] / (l === 0 ? NaN_ : l);
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

/**
 * VOLUME RSI: Wilder smoothing ewm(alpha=1/n, adjust=False) of gains/losses,
 * rs = g / ls.replace(0, NaN), 100 − 100/(1+rs), then fillna(50).
 */
function rsiWilder(close, n = 14) {
  const d = diff(close, 1);
  const g = ewmAlpha(clipLower(d, 0.0), 1.0 / n);
  const ls = ewmAlpha(neg(clipUpper(d, 0.0)), 1.0 / n);
  const out = new Float64Array(d.length);
  for (let i = 0; i < d.length; i++) {
    const l = ls[i];
    const rs = g[i] / (l === 0 ? NaN_ : l);
    const r = 100.0 - 100.0 / (1.0 + rs);
    out[i] = r === r ? r : 50.0;
  }
  return out;
}

/** VOLUME volume average excluding the current bar: vol.shift(1).rolling(n).mean(). */
function volumeAvgExcludingLast(volume, n) {
  return rollingMean(shift(volume, 1), n, n);
}

/**
 * Series.reindex(targetIndex, method='nearest') on a monotonic increasing source
 * index: left = last src ≤ t, right = first src ≥ t; pick left when
 * |t−left| < |right−t| (strict), else right; missing side → the other.
 * Returns the reindexed values (NaN where the source is empty).
 */
function reindexNearest(srcT, srcV, dstT) {
  const n = srcT.length;
  const m = dstT.length;
  const out = new Float64Array(m);
  let lo = 0;
  for (let k = 0; k < m; k++) {
    const t = dstT[k];
    // advance lo to the first src >= t (dstT is typically sorted; fall back to a binary search otherwise)
    if (k > 0 && t < dstT[k - 1]) lo = 0;
    while (lo < n && srcT[lo] < t) lo++;
    const right = lo < n ? lo : -1;
    const left = (lo < n && srcT[lo] === t) ? lo : lo - 1;
    if (n === 0) { out[k] = NaN_; continue; }
    if (left < 0) { out[k] = srcV[right]; continue; }
    if (right < 0) { out[k] = srcV[left]; continue; }
    const dl = Math.abs(srcT[left] - t), dr = Math.abs(srcT[right] - t);
    out[k] = dl < dr ? srcV[left] : srcV[right];
  }
  return out;
}

module.exports = {
  toF64,
  // numpy reductions
  pairwiseSum, npSum, npMean, npVar, npStd, seriesMean, seriesMin, seriesMax, seqSum, kahanSum,
  // elementwise
  shift, diff, ffill, pctChange, clipLower, clipUpper, neg, abs, fillna, replaceZeroNaN,
  cumsum, seriesCumsum, cummax, cummin, linspace,
  // ewm
  ewmCom, ewmSpan, ewmSpanAdjust, ewmAlpha, wilder,
  // rolling
  rollingMean, rollingSum, rollingVar, rollingStd, rollingMax, rollingMin, sma, rollingCorr, pearson,
  // quantiles
  quantileCore, npQuantile, seriesQuantile,
  // indicators
  trueRange, atrEmaSpan, atrWilder, atrSma, rsiSpan, rsiWilder, volumeAvgExcludingLast, reindexNearest,
};
