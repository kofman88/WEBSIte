/**
 * kde.js — scipy.stats.gaussian_kde / scipy.signal.argrelextrema / LEVELS volume profile.
 *
 * Reference values from scipy 1.17.1 / numpy 1.26.4 (python 3.12.3):
 *   from scipy.stats import gaussian_kde; import numpy as np
 *   k = gaussian_kde([1.0,2.0,2.5,4.0,7.0], bw_method=0.5); xs = np.linspace(0,10,11)
 *   k.factor, k.cho_cov[0,0], k.covariance[0,0], k(xs).tolist()
 *     → 0.5, 1.1672617529928753, 1.3625, [0.07019831114204458, 0.14816311771234525, 0.19383379086195554,
 *        0.173022595346864, 0.1190685586067451, 0.07271253837791343, 0.0640708754440828, 0.0709171778223758,
 *        0.04755228798705251, 0.015756909970283086, 0.002514353487928245]
 *   gaussian_kde([1,2,2.5,4,7], bw_method='silverman').factor → 0.767703899274755 ; (default scott) → 0.7247796636776956
 *   argrelextrema(np.array([0,1,3,2,2,5,4,1,6,0.5,0.2,7.]), np.greater, order=1)[0] → [2, 5, 8] ; order=3 → []
 *
 * Densities are compared with a 1e-12 relative tolerance: the sample-variance dot
 * product (BLAS) and exp() differ from glibc by ≤ 1 ulp (see kde.js header);
 * bandwidths, factors and peak indices are exact.
 */
import { describe, it, expect } from 'vitest';
import K from '../../strategies/common/kde.js';
import S from '../../strategies/common/series.js';

const close = (a, b, rel = 1e-12) => Math.abs(a - b) <= rel * Math.max(1e-300, Math.abs(b));

describe('gaussianKde', () => {
  const pts = [1.0, 2.0, 2.5, 4.0, 7.0];
  const xs = S.linspace(0, 10, 11);
  it('scalar bw_method is the factor multiplying the sample std (ddof=1 weighted cov)', () => {
    const k = K.gaussianKde(pts, 0.5);
    expect(k.factor).toBe(0.5);
    expect(k.covariance).toBe(1.3625);
    expect(close(k.choCov, 1.1672617529928753, 1e-15)).toBe(true);
  });
  it('density on linspace(0,10,11) matches scipy', () => {
    const ys = K.gaussianKde(pts, 0.5).evaluate(xs);
    const want = [0.07019831114204458, 0.14816311771234525, 0.19383379086195554, 0.173022595346864, 0.1190685586067451,
      0.07271253837791343, 0.0640708754440828, 0.0709171778223758, 0.04755228798705251, 0.015756909970283086, 0.002514353487928245];
    for (let i = 0; i < 11; i++) expect(close(ys[i], want[i])).toBe(true);
  });
  it('silverman and scott factors', () => {
    expect(close(K.gaussianKde(pts, 'silverman').factor, 0.767703899274755, 1e-15)).toBe(true);
    expect(close(K.gaussianKde(pts).factor, 0.7247796636776956, 1e-15)).toBe(true);
    // k_s(xs)[:3] → [0.0825253716704543, 0.12511725291890702, 0.15023524388737694]
    const ys = K.gaussianKde(pts, 'silverman').evaluate(xs);
    expect(close(ys[0], 0.0825253716704543)).toBe(true);
    expect(close(ys[1], 0.12511725291890702)).toBe(true);
    expect(close(ys[2], 0.15023524388737694)).toBe(true);
  });
  // gaussian_kde([2.0]*5, 0.5) → LinAlgError (cov exactly 0); gaussian_kde([3.0]*5, 0.5).covariance[0,0] → 6.162975822039155e-32
  // (the weighted mean of five 3.0 is 3.0000000000000004, so the covariance is float noise, not 0 — reproduced bit-exact)
  it('zero-variance data raises like scipy (LinAlgError) only when the covariance is exactly 0', () => {
    expect(() => K.gaussianKde([2, 2, 2, 2, 2], 0.5)).toThrow();
    expect(() => K.gaussianKde([3], 0.5)).toThrow();
    expect(K.gaussianKde([3, 3, 3, 3, 3], 0.5).covariance).toBe(6.162975822039155e-32);
  });
});

describe('argrelextremaGreater (mode=clip)', () => {
  const ys = [0.0, 1.0, 3.0, 2.0, 2.0, 5.0, 4.0, 1.0, 6.0, 0.5, 0.2, 7.0];
  it('order 1/2/3/10', () => {
    expect(K.argrelextremaGreater(ys, 1)).toEqual([2, 5, 8]);
    expect(K.argrelextremaGreater(ys, 2)).toEqual([2, 5, 8]);
    expect(K.argrelextremaGreater(ys, 3)).toEqual([]);
    expect(K.argrelextremaGreater(ys, 10)).toEqual([]);
  });
  // argrelextrema(np.array([9.0,1.0,2.0,1.0,9.5]), np.greater, order=1)[0] → [2]
  it('edges are never peaks (clipped index compares the edge with itself)', () => {
    expect(K.argrelextremaGreater([9.0, 1.0, 2.0, 1.0, 9.5], 1)).toEqual([2]);
    expect(K.argrelextremaGreater([5, 4, 3], 1)).toEqual([]);
  });
  it('plateaus are not strict maxima', () => {
    expect(K.argrelextremaGreater([0, 2, 2, 0], 1)).toEqual([]);
  });
});

describe('LEVELS bandwidth factor + kdeLevels', () => {
  // arr=np.array([1.0,1.1,1.2,1.25,1.3,2.0,2.05,2.1,2.2,2.3,2.9,3.0]); std=arr.std(); pr=arr.max()-arr.min()
  // sb=int(round(std/pr*1000)); 1.06*(sb/1000.0)*(len(arr)**-0.2) → std=0.6609126686299451, sb=330, factor=0.21280584679424341
  // peaks of gaussian_kde(arr, bw_method=factor)(np.linspace(0.9,3.1,500)) with order=10 → [65, 275, 465]
  const arr = [1.0, 1.1, 1.2, 1.25, 1.3, 2.0, 2.05, 2.1, 2.2, 2.3, 2.9, 3.0];
  it('kdeBandwidthFactor uses python round (half-even) and glibc pow', () => {
    const std = S.npStd(arr, 0);
    expect(std).toBe(0.6609126686299451);
    const bw = K.kdeBandwidthFactor(arr.length, std, 2.0);
    expect(bw).toBe(0.21280584679424341);
    expect(K.kdeBandwidthFactor(4, std, 2.0)).toBe(null);
    expect(K.kdeBandwidthFactor(12, 0, 2.0)).toBe(null);
    expect(K.kdeBandwidthFactor(12, 0.0004, 2.0)).toBe(null); // bucket 0
  });
  it('kdeLevels returns the peak prices of the grid', () => {
    const dbg = [];
    const peaks = K.kdeLevels(arr, [0.9, 3.1], 500, { debug: dbg });
    expect(dbg[0].peaks).toEqual([65, 275, 465]);
    expect(peaks).toEqual([1.1865731462925853, 2.112424849699399, 2.9501002004008017]);
    expect(K.kdeLevels([1, 2, 3, 4], [0, 5])).toEqual([]);
    expect(K.kdeLevels([2, 2, 2, 2, 2], [0, 5])).toEqual([]); // singular covariance → scipy raises → []
  });
});

describe('volumeProfile (indicator._volume_profile)', () => {
  // lows/highs/vols as below; bins=np.linspace(lo,hi,51); mid=(bins[:-1]+bins[1:])/2; mask=(mid>=lows[:,None])&(mid<=highs[:,None])
  // spans=mask.sum(1).clip(min=1).astype(float); vols=(mask*(v/spans)[:,None]).sum(0); avg=vols.mean() → 37.8
  const lows = [1.0, 1.2, 1.1, 1.5, 1.4, 1.0, 1.3, 1.6, 1.2, 1.1, 1.0, 1.3];
  const highs = [1.5, 1.5, 1.7000000000000002, 1.7, 1.7999999999999998, 1.9, 1.6, 1.8, 1.7, 1.8, 1.4, 1.6];
  const vols = [100.0, 200.0, 50.0, 300.0, 120.0, 80.0, 400.0, 60.0, 150.0, 90.0, 210.0, 130.0];
  it('bin volumes, average, HVN/LVN centres are exact', () => {
    const vp = K.volumeProfile(lows, highs, vols, 50);
    expect(vp.volumes[0]).toBe(14.716883116883118);
    expect(vp.volumes[6]).toBe(18.60045568466621);
    expect(vp.volumes[17]).toBe(68.847304424162);
    expect(vp.volumes[49]).toBe(1.6);
    expect(S.npMean(vp.volumes)).toBe(37.8);
    expect(vp.hvn).toEqual([1.315, 1.333, 1.351, 1.3689999999999998, 1.387, 1.4049999999999998, 1.423, 1.4409999999999998, 1.459,
      1.4769999999999999, 1.495, 1.513, 1.531, 1.549, 1.567, 1.585]);
    expect(vp.lvn).toEqual([1.009, 1.0270000000000001, 1.045, 1.0630000000000002, 1.081, 1.0990000000000002, 1.117, 1.1349999999999998,
      1.153, 1.1709999999999998, 1.189, 1.7109999999999999, 1.729, 1.7469999999999999, 1.765, 1.783, 1.801, 1.819, 1.837, 1.855,
      1.8729999999999998, 1.891]);
  });
  it('needs ≥ 10 bars and a positive range', () => {
    expect(K.volumeProfile([1, 1], [2, 2], [1, 1]).hvn).toEqual([]);
    expect(K.volumeProfile(new Array(12).fill(1), new Array(12).fill(1), vols).volumes.length).toBe(0);
  });
});
