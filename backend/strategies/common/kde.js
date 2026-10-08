'use strict';
/**
 * kde.js — scipy.stats.gaussian_kde (1-D, scalar/silverman bw_method) and
 * scipy.signal.argrelextrema(np.greater, order, mode='clip'), plus the LEVELS
 * volume-profile helper and the bot's bandwidth-factor function.
 *
 * scipy 1.17.1 semantics (scipy/stats/_kde.py + _stats.pyx::gaussian_kernel_estimate):
 *   weights        = ones(n)/n
 *   _data_covariance = np.cov(dataset, rowvar=1, bias=False, aweights=weights)
 *   _data_cho_cov    = cholesky(cov) = sqrt(cov)              (1×1)
 *   cho_cov          = _data_cho_cov * factor                  (kernel std)
 *   points_ = points / cho_cov, xi_ = xi / cho_cov             (dtrsm: multiply by 1/cho_cov)
 *   norm = (2π)^(−1/2) / cho_cov
 *   estimate[j] = Σ_i w_i · exp(−(points_i − xi_j)² / 2) · norm   (sequential over i)
 *
 * Fidelity note: numpy's weighted covariance ends in a BLAS dot product whose
 * summation order (OpenBLAS kernel, FMA) is not reproducible from JS, and V8's
 * Math.exp differs from glibc's exp by 1 ulp on ~10% of inputs. Densities are
 * therefore equal to scipy's to ~1e-15 relative, not bit-for-bit; peak indices
 * (what LEVELS consumes) only move on exact ties of neighbouring densities.
 * The bandwidth factor's `n ** -0.2` is bit-exact via the glibc table.
 */

const { npSum, seqSum, linspace, npMean, npStd, seriesMin, seriesMax } = require('./series');
const { pyRoundInt } = require('./pyround');
const { powNm02 } = require('./glibcPow');

const NORM_2PI = Math.pow(2 * Math.PI, -0.5); // identical to glibc pow(2π, −0.5) (verified)

/**
 * np.cov(x, rowvar=1, bias=False, aweights=ones(n)/n) for a 1-D sample:
 *   avg  = Σ(x·w) / Σw                       (numpy pairwise sums)
 *   fact = Σw − Σ(w·w)/Σw                    (python builtin sum → sequential)
 *   c    = dot(x−avg, (x−avg)·w) · (1/fact)
 */
function covAweights(x) {
  const n = x.length;
  const w = 1.0 / n;
  const wArr = new Float64Array(n).fill(w);
  const xw = new Float64Array(n);
  for (let i = 0; i < n; i++) xw[i] = x[i] * w;
  const scl = npSum(wArr);
  const avg = npSum(xw) / scl;
  const ww = new Float64Array(n);
  for (let i = 0; i < n; i++) ww[i] = w * w;
  const fact = scl - 1 * seqSum(ww) / scl;
  let c = 0.0;
  for (let i = 0; i < n; i++) {
    const d = x[i] - avg;
    c += d * (d * w);
  }
  return c * (1 / fact);
}

/** scipy silverman_factor for d=1: (neff·3/4)^(−1/5), neff = 1/Σw². */
function silvermanFactor(n) {
  const w = 1.0 / n;
  const ww = new Float64Array(n).fill(w * w);
  const neff = 1 / npSum(ww);
  return Math.pow(neff * 3.0 / 4.0, -1.0 / 5);
}

/** scipy scotts_factor for d=1: neff^(−1/5). */
function scottsFactor(n) {
  const w = 1.0 / n;
  const ww = new Float64Array(n).fill(w * w);
  const neff = 1 / npSum(ww);
  return Math.pow(neff, -1.0 / 5);
}

/**
 * gaussian_kde(dataset, bw_method) with bw_method a number (= factor, kernel std
 * = factor × sample std ddof≈1) or 'silverman' / 'scott'.
 * Throws (like scipy's LinAlgError) when the sample variance is 0.
 */
function gaussianKde(dataset, bwMethod = 'scott') {
  const data = Float64Array.from(dataset, Number);
  const n = data.length;
  if (n <= 1) throw new Error('`dataset` input should have multiple elements.');
  let factor;
  if (typeof bwMethod === 'number') factor = bwMethod;
  else if (bwMethod === 'silverman') factor = silvermanFactor(n);
  else if (bwMethod === 'scott' || bwMethod == null) factor = scottsFactor(n);
  else throw new Error('`bw_method` should be \'scott\', \'silverman\', a scalar or a callable.');
  const cov = covAweights(data);
  if (!(cov > 0) || !Number.isFinite(cov)) {
    throw new Error('The data appears to lie in a lower-dimensional subspace (singular covariance matrix)');
  }
  const dataChoCov = Math.sqrt(cov);
  const choCov = dataChoCov * factor;
  const weight = 1.0 / n;

  function evaluate(points) {
    const xs = Float64Array.from(points, Number);
    const m = xs.length;
    const inv = 1.0 / choCov;
    const pts = new Float64Array(n);
    for (let i = 0; i < n; i++) pts[i] = data[i] * inv;
    const xi = new Float64Array(m);
    for (let j = 0; j < m; j++) xi[j] = xs[j] * inv;
    let norm = NORM_2PI;
    norm /= choCov;
    const est = new Float64Array(m);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      for (let j = 0; j < m; j++) {
        const r = p - xi[j];
        let arg = 0 + r * r;
        arg = Math.exp(-arg / 2.0) * norm;
        est[j] += weight * arg;
      }
    }
    return est;
  }

  return { n, d: 1, factor, covariance: cov * (factor * factor), choCov, dataChoCov, evaluate };
}

/**
 * scipy.signal.argrelextrema(data, np.greater, order, mode='clip') for a 1-D
 * array: index i is a peak when data[i] > data[clip(i±k)] for every k = 1..order
 * (indices clipped to [0, n−1], so the two edges can never be peaks).
 */
function argrelextremaGreater(data, order = 1) {
  const n = data.length;
  const out = [];
  if (!(order >= 1) || Math.floor(order) !== order) throw new Error('Order must be an int >= 1');
  for (let i = 0; i < n; i++) {
    const v = data[i];
    let ok = true;
    for (let k = 1; k <= order && ok; k++) {
      const plus = Math.min(n - 1, i + k);
      const minus = Math.max(0, i - k);
      if (!(v > data[plus]) || !(v > data[minus])) ok = false;
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * indicator._kde_bw_cached(n, std, price_range) → factor or null (fallback to
 * 'silverman'). std = numpy std (ddof=0) of the pivot prices.
 *   std_bucket = int(round(std / price_range * 1000))   (Python round → half-even)
 *   factor     = 1.06 * (std_bucket / 1000) * n ** -0.2  (glibc pow)
 */
function kdeBandwidthFactor(n, std, priceRange) {
  if (n < 5 || std <= 0 || priceRange <= 0) return null;
  const stdBucket = pyRoundInt(std / priceRange * 1000);
  if (stdBucket <= 0) return null;
  if (n <= 1 || stdBucket <= 0) return 0.05;
  const s = stdBucket / 1000.0;
  return 1.06 * s * powNm02(n);
}

/**
 * indicator._kde_levels(pivot_prices, price_range, n_points=500): KDE peaks on
 * linspace(lo, hi, 500). Returns [] when fewer than 5 pivots or on any error
 * (scipy LinAlgError for zero-variance pivots), like the bot.
 */
function kdeLevels(pivotPrices, priceRange, nPoints = 500, opts = {}) {
  if (pivotPrices.length < 5) return [];
  try {
    const arr = Float64Array.from(pivotPrices, Number);
    const std = npStd(arr, 0);
    const range = seriesMax(arr) - seriesMin(arr);
    const bw = kdeBandwidthFactor(arr.length, std, range);
    const kde = gaussianKde(arr, bw === null ? 'silverman' : bw);
    const xs = linspace(priceRange[0], priceRange[1], nPoints);
    const ys = kde.evaluate(xs);
    const peaks = argrelextremaGreater(ys, opts.order || 10);
    if (opts.debug) opts.debug.push({ bw, factor: kde.factor, choCov: kde.choCov, xs, ys, peaks });
    return peaks.map((i) => xs[i]);
  } catch (_e) {
    return [];
  }
}

/**
 * indicator._volume_profile(df, n_bins=50): bar volume spread equally over the
 * bins whose centre lies in [low, high]; HVN > 1.5·avg, LVN < 0.5·avg.
 * numpy-exact: vols = (mask2d * share[:, None]).sum(axis=0) — a False cell adds
 * 0·share (NaN for a NaN / ±inf share, so one non-finite volume leaves no HVN/LVN),
 * column sums are sequential over bars from +0.0 (axis-0 reduction), avg = np.mean;
 * lo/hi skip NaN and an all-NaN column (NaN) passes the `hi <= lo` guard like Python.
 * Pinned by tests/common/fixtures/volume_profile_expected.json (gen_volume_profile.py).
 */
function volumeProfile(low, high, volume, nBins = 50) {
  const result = { hvn: [], lvn: [], binEdges: new Float64Array(0), volumes: new Float64Array(0) };
  const n = low.length;
  if (n < 10) return result;
  const lo = seriesMin(low), hi = seriesMax(high);
  if (hi <= lo) return result;
  const bins = linspace(lo, hi, nBins + 1);
  const mid = new Float64Array(nBins);
  for (let b = 0; b < nBins; b++) mid[b] = (bins[b] + bins[b + 1]) / 2;
  const vols = new Float64Array(nBins);
  for (let i = 0; i < n; i++) {
    const l = low[i], h = high[i];
    let spans = 0;
    for (let b = 0; b < nBins; b++) if (mid[b] >= l && mid[b] <= h) spans++;
    const share = volume[i] / Math.max(spans, 1);
    const off = 0 * share;                       // False cell: 0.0 * share (NaN when share is not finite)
    for (let b = 0; b < nBins; b++) {
      vols[b] += (mid[b] >= l && mid[b] <= h) ? share : off;
    }
  }
  const avg = npMean(vols);
  const hvn = [], lvn = [];
  for (let b = 0; b < nBins; b++) {
    if (avg > 0 && vols[b] > avg * 1.5) hvn.push(mid[b]);
    if (avg > 0 && vols[b] < avg * 0.5) lvn.push(mid[b]);
  }
  result.hvn = hvn; result.lvn = lvn; result.binEdges = bins; result.volumes = vols;
  return result;
}

module.exports = {
  gaussianKde, covAweights, silvermanFactor, scottsFactor, argrelextremaGreater,
  kdeBandwidthFactor, kdeLevels, volumeProfile, NORM_2PI,
};
