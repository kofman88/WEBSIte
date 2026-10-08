/**
 * series.js — pandas 2.3.3 / numpy 1.26.4 semantics pinned with reference vectors.
 *
 * Every expected vector below was produced by the exact Python/pandas/numpy versions
 * the golden fixtures were made with (python 3.12.3, pandas 2.3.3, numpy 1.26.4); the
 * one-liner that produced it is quoted above each block. Values are repr() (shortest
 * round-trip) so the JS literals are the identical doubles → comparisons are EXACT
 * (Object.is), not approximate. NaN is written as null in the Python output.
 */
import { describe, it, expect } from 'vitest';
import S from '../../strategies/common/series.js';

const N = Number.NaN;
const nn = (arr) => arr.map((v) => (v === null ? N : v));
function expectExact(actual, expected) {
  const a = Array.from(actual);
  const e = nn(expected);
  expect(a.length).toBe(e.length);
  for (let i = 0; i < e.length; i++) {
    if (!Object.is(a[i], e[i])) {
      throw new Error(`index ${i}: got ${a[i]} want ${e[i]} (bits differ)\n got=${JSON.stringify(a)}\nwant=${JSON.stringify(e)}`);
    }
  }
}

const X = [10.0, 11.0, 10.5, 12.0, 11.5, 13.0, 12.5, 12.0, 14.0, 13.5];

describe('ewm (pandas ewm().mean())', () => {
  // pd.Series(X).ewm(span=3, adjust=False).mean().tolist()
  it('span=3 adjust=False', () => {
    expectExact(S.ewmSpan(X, 3), [10.0, 10.5, 10.5, 11.25, 11.375, 12.1875, 12.34375, 12.171875, 13.0859375, 13.29296875]);
  });
  // pd.Series(X).ewm(span=3, adjust=True, min_periods=1).mean().tolist()
  it('span=3 adjust=True min_periods=1 (recursive weighted form, first 5 values differ from adjust=False)', () => {
    expectExact(S.ewmSpanAdjust(X, 3), [10.0, 10.666666666666666, 10.571428571428571, 11.333333333333334, 11.419354838709678,
      12.222222222222221, 12.362204724409448, 12.180392156862744, 13.09197651663405, 13.296187683284458]);
  });
  // pd.Series(X).ewm(span=14, adjust=False).mean().tolist()
  it('span=14 adjust=False (LEVELS/SMC EMA)', () => {
    expectExact(S.ewmSpan(X, 14), [10.0, 10.133333333333335, 10.182222222222224, 10.424592592592594, 10.567980246913582,
      10.892249547325104, 11.106616274348424, 11.2257341044353, 11.595636223843927, 11.849551393998071]);
  });
  // pd.Series(X).ewm(span=14, adjust=True, min_periods=1).mean().tolist()
  it('span=14 adjust=True (VOLUME EMA)', () => {
    expectExact(S.ewmSpanAdjust(X, 14), [10.0, 10.535714285714286, 10.52207130730051, 10.974211385061642, 11.111388830195683,
      11.548379783954946, 11.748906340193878, 11.798016562655732, 12.203452899313875, 12.430638616631486]);
  });
  // pd.Series(X).ewm(alpha=1/3, adjust=False).mean().tolist()
  it('alpha=1/3 adjust=False (Wilder form; alpha → com → alpha round trip)', () => {
    expectExact(S.ewmAlpha(X, 1 / 3), [10.0, 10.333333333333334, 10.38888888888889, 10.925925925925927, 11.117283950617285,
      11.74485596707819, 11.996570644718794, 11.997713763145864, 12.66514250876391, 12.943428339175941]);
    expectExact(S.wilder(X, 3), S.ewmAlpha(X, 1 / 3));
  });
  // pd.Series([nan, nan, 1.0, 2.0, nan, 4.0, 5.0]).ewm(span=3, adjust=False).mean().tolist()
  it('leading NaNs are skipped, an interior NaN decays the weight (ignore_na=False)', () => {
    const xn = [N, N, 1.0, 2.0, N, 4.0, 5.0];
    expectExact(S.ewmSpan(xn, 3), [null, null, 1.0, 1.5, 1.5, 3.1666666666666665, 4.083333333333333]);
    // pd.Series([nan, nan, 1.0, 2.0, nan, 4.0, 5.0]).ewm(span=3, adjust=True, min_periods=1).mean().tolist()
    expectExact(S.ewmSpanAdjust(xn, 3), [null, null, 1.0, 1.6666666666666667, 1.6666666666666667, 3.3636363636363638, 4.333333333333333]);
  });
  // pd.Series([7.0]*6).ewm(span=5, adjust=True, min_periods=1).mean().tolist()
  it('constant series stays exactly constant (weighted != cur guard)', () => {
    expectExact(S.ewmSpanAdjust([7, 7, 7, 7, 7, 7], 5), [7.0, 7.0, 7.0, 7.0, 7.0, 7.0]);
  });
});

describe('RSI', () => {
  const up = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
  const mixed = [10.0, 10.5, 10.2, 10.8, 10.6, 11.0, 10.4, 10.9, 11.3, 11.1, 11.6, 11.2, 11.8, 12.0, 11.7, 12.3];
  // s=pd.Series(up); d=s.diff(); g=d.clip(lower=0).ewm(span=14,adjust=False).mean(); l=(-d.clip(upper=0)).ewm(span=14,adjust=False).mean(); (100-100/(1+g/l.replace(0,np.nan))).tolist()
  it('LEVELS rsiSpan: zero losses → NaN (kept)', () => {
    expectExact(S.rsiSpan(up, 14), [null, null, null, null, null, null, null, null]);
  });
  // rsi_wilder(up) with .fillna(50.0)  (volume_strategy._rsi)
  it('VOLUME rsiWilder: zero losses → 50', () => {
    expectExact(S.rsiWilder(up, 14), [50.0, 50.0, 50.0, 50.0, 50.0, 50.0, 50.0, 50.0]);
  });
  // rsi_levels(mixed)
  it('LEVELS rsiSpan on a mixed series', () => {
    expectExact(S.rsiSpan(mixed, 14), [null, null, 91.54929577464787, 92.92837715321848, 87.44012074283086, 88.94658984394084,
      73.65606352884114, 77.39290410137359, 80.0102928155321, 75.00065405280955, 78.82510974978072, 69.07125608801664,
      74.52676137705508, 76.14512635320997, 68.60173605001108, 74.44415411351955]);
  });
  // rsi_wilder(mixed)
  it('VOLUME rsiWilder on a mixed series (n=14 and n=3)', () => {
    expectExact(S.rsiWilder(mixed, 14), [50.0, 50.0, 95.58823529411764, 95.97107438016528, 93.07182490752156, 93.49507970433696,
      85.0971190836934, 86.20882468601437, 87.04163202154906, 84.30051132247308, 85.52757508516989, 80.13171440509869,
      81.96928280174221, 82.54867798430553, 78.4751565013463, 80.5431410872991]);
    expectExact(S.rsiWilder(mixed, 3), [50.0, 50.0, 76.92307692307689, 86.36363636363635, 71.69811320754711, 81.24999999999994,
      46.18117229129664, 65.04182290164408, 75.39086294416244, 61.6931129018858, 77.21640952157419, 51.952725670924764,
      72.32547841593164, 77.16637520649893, 55.3729360087196, 75.84153867988215]);
  });
  // rsi_wilder([5.0,5.0,5.0,4.0,3.0], 3)
  it('VOLUME rsiWilder: flat then down → 50,50,50,0,0', () => {
    expectExact(S.rsiWilder([5, 5, 5, 4, 3], 3), [50.0, 50.0, 50.0, 0.0, 0.0]);
  });
});

describe('rolling windows (pandas Kahan/Welford online algorithms)', () => {
  const y = [1.0, 2.0, 4.0, 7.0, 11.0, 16.0, 22.0, 29.0, 37.0, 46.0];
  // pd.Series(y).rolling(3).mean().tolist()
  it('rollingMean / sma', () => {
    expectExact(S.rollingMean(y, 3), [null, null, 2.3333333333333335, 4.333333333333333, 7.333333333333333, 11.333333333333334,
      16.333333333333332, 22.333333333333332, 29.333333333333332, 37.333333333333336]);
    expectExact(S.sma(y, 3), S.rollingMean(y, 3));
    // pd.Series(y).rolling(3, min_periods=1).mean().tolist()
    expectExact(S.rollingMean(y, 3, 1), [1.0, 1.5, 2.3333333333333335, 4.333333333333333, 7.333333333333333, 11.333333333333334,
      16.333333333333332, 22.333333333333332, 29.333333333333332, 37.333333333333336]);
  });
  // pd.Series(y).rolling(3).std(ddof=0).tolist() / .std(ddof=1) / .var()
  it('rollingStd ddof=0 and ddof=1, rollingVar', () => {
    expectExact(S.rollingStd(y, 3, 0), [null, null, 1.247219128924647, 2.0548046676563256, 2.8674417556808756, 3.6817870057290873,
      4.4969125210773475, 5.312459150169744, 6.128258770283414, 6.944222218666554]);
    expectExact(S.rollingStd(y, 3, 1), [null, null, 1.5275252316519465, 2.5166114784235836, 3.5118845842842465, 4.509249752822894,
      5.507570547286103, 6.506407098647713, 7.505553499465138, 8.504900548115383]);
    expectExact(S.rollingVar(y, 3, 1), [null, null, 2.333333333333333, 6.333333333333334, 12.333333333333336, 20.333333333333336,
      30.33333333333334, 42.33333333333336, 56.33333333333337, 72.33333333333336]);
  });
  // pd.Series(y).rolling(3).max() / .min() / .sum()
  it('rollingMax / rollingMin / rollingSum', () => {
    expectExact(S.rollingMax(y, 3), [null, null, 4.0, 7.0, 11.0, 16.0, 22.0, 29.0, 37.0, 46.0]);
    expectExact(S.rollingMin(y, 3), [null, null, 1.0, 2.0, 4.0, 7.0, 11.0, 16.0, 22.0, 29.0]);
    expectExact(S.rollingSum(y, 3), [null, null, 7.0, 13.0, 22.0, 34.0, 49.0, 67.0, 88.0, 112.0]);
  });
  // z=[1e8,1.0,-1e8,0.5,0.25,1e8,-1e8,2.0]; pd.Series(z).rolling(3).mean().tolist(); pd.Series(z).rolling(3).std(ddof=0).tolist()
  it('path-dependent rounding of the online algorithm is reproduced (cancellation case)', () => {
    const z = [1e8, 1.0, -1e8, 0.5, 0.25, 1e8, -1e8, 2.0];
    expectExact(S.rollingMean(z, 3), [null, null, 0.3333333333333333, -33333332.833333332, -33333333.083333332, 33333333.583333332,
      0.08333333333333333, 0.6666666666666666]);
    expectExact(S.rollingStd(z, 3, 0), [null, null, 81649658.0927726, 47140452.432656564, 47140452.255879864, 47140451.90232647,
      81649658.0927726, 81649658.09277262]);
  });
  // pd.Series([0.1,0.1,0.1,0.1,0.2,0.1,0.1,0.1]).rolling(3).mean().tolist() / .std().tolist()
  it('consecutive identical values short-circuit to the value / zero variance (GH#42064)', () => {
    const v = [0.1, 0.1, 0.1, 0.1, 0.2, 0.1, 0.1, 0.1];
    expectExact(S.rollingMean(v, 3), [null, null, 0.1, 0.1, 0.13333333333333333, 0.13333333333333333, 0.13333333333333333, 0.1]);
    expectExact(S.rollingStd(v, 3, 1), [null, null, 0.0, 0.0, 0.05773502691896258, 0.05773502691896258, 0.05773502691896258, 0.0]);
  });
  // pd.Series([1.0,nan,3.0,4.0,5.0]).rolling(3).mean().tolist(); ...rolling(3, min_periods=2)
  it('NaN inside the window counts against min_periods', () => {
    expectExact(S.rollingMean([1, N, 3, 4, 5], 3), [null, null, null, null, 4.0]);
    expectExact(S.rollingMean([1, N, 3, 4, 5], 3, 2), [null, null, 2.0, 3.5, 4.0]);
  });
});

describe('rollingCorr (pandas Rolling.corr formula, ddof=1)', () => {
  const a = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
  const b = [2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0, 16.0];
  // pd.Series(a).rolling(4).corr(pd.Series(b)).tolist()
  it('perfect correlation is 0.9999999999999999 like pandas (not 1.0)', () => {
    expectExact(S.rollingCorr(a, b, 4), [null, null, null, 0.9999999999999999, 0.9999999999999999, 0.9999999999999999, 0.9999999999999999, 0.9999999999999999]);
  });
  // pd.Series([3.0]*8).rolling(4).corr(pd.Series(b)).tolist(); pd.Series([1.0]*8).rolling(4).corr(pd.Series(b)).tolist()
  it('zero variance → NaN', () => {
    expectExact(S.rollingCorr([3, 3, 3, 3, 3, 3, 3, 3], b, 4), [null, null, null, null, null, null, null, null]);
    expectExact(S.rollingCorr([1, 1, 1, 1, 1, 1, 1, 1], b, 4), [null, null, null, null, null, null, null, null]);
  });
  // d=[1,3,2,5,4,7,6,9]; pd.Series(a).rolling(4).corr(pd.Series(d)).tolist()
  it('general case', () => {
    expectExact(S.rollingCorr(a, [1, 3, 2, 5, 4, 7, 6, 9], 4), [null, null, null, 0.8315218406202999, 0.6000000000000001, 0.8682431421244592, 0.5999999999999999, 0.8682431421244592]);
  });
  // e=[1,3,nan,5,4,7,6,9]; pd.Series(a).rolling(4).corr(pd.Series(e)).tolist(); pd.Series(a).rolling(4, min_periods=3).corr(pd.Series(e)).tolist()
  it('NaN on either side masks both (prep_binary) and counts against min_periods', () => {
    const e = [1, 3, N, 5, 4, 7, 6, 9];
    expectExact(S.rollingCorr(a, e, 4), [null, null, null, null, null, null, 0.5999999999999999, 0.8682431421244592]);
    expectExact(S.rollingCorr(a, e, 4, 3), [null, null, null, 0.9819805060619659, 0.6546536707079784, 0.6546536707079783, 0.5999999999999999, 0.8682431421244592]);
  });
});

describe('quantile (numpy linear / pandas Series.quantile)', () => {
  // pd.Series([1.0,2.0,3.0,4.0]).quantile(0.3) == np.quantile([1,2,3,4], 0.3) == 1.9
  it('quantile([1,2,3,4], 0.3) = 1.9', () => {
    expect(S.seriesQuantile([1, 2, 3, 4], 0.3)).toBe(1.9);
    expect(S.npQuantile([1, 2, 3, 4], 0.3)).toBe(1.9);
    expect(S.seriesQuantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(S.seriesQuantile([1, 2, 3, 4], 0.0)).toBe(1.0);
    expect(S.seriesQuantile([1, 2, 3, 4], 1.0)).toBe(4.0);
  });
  // qq=[0.37,0.05,1.2,0.9,0.42,0.11,0.73]; pd.Series(qq).quantile(0.15), .quantile(0.3), np.quantile(qq,0.15), np.quantile(qq,0.3)
  it('unsorted input, squeeze percentiles 15/30 (lerp with the t>=0.5 branch)', () => {
    const qq = [0.37, 0.05, 1.2, 0.9, 0.42, 0.11, 0.73];
    expect(S.seriesQuantile(qq, 0.15)).toBe(0.104);
    expect(S.seriesQuantile(qq, 0.3)).toBe(0.31799999999999995);
    expect(S.npQuantile(qq, 0.15)).toBe(0.104);
    expect(S.npQuantile(qq, 0.3)).toBe(0.31799999999999995);
  });
  // pd.Series([1.0,nan,3.0,2.0]).quantile(0.5) == 2.0 ; pd.Series([2.5]).quantile(0.3) == 2.5
  it('NaNs dropped, single element, empty → NaN', () => {
    expect(S.seriesQuantile([1, N, 3, 2], 0.5)).toBe(2.0);
    expect(S.seriesQuantile([2.5], 0.3)).toBe(2.5);
    expect(Number.isNaN(S.seriesQuantile([], 0.3))).toBe(true);
  });
});

describe('numpy reductions (pairwise summation) and pandas means', () => {
  // np.sum([0.1]*10) == 1.0 ; functools.reduce(operator.add, [0.1]*10) == 0.9999999999999999
  // (python 3.12's builtin sum() is Neumaier-compensated for exact floats and gives 1.0; the
  //  bot only feeds numpy scalars to sum(), which take the plain sequential path = seqSum)
  it('npSum uses pairwise summation (differs from a sequential sum)', () => {
    const v = new Array(10).fill(0.1);
    expect(S.npSum(v)).toBe(1.0);
    expect(S.seqSum(v)).toBe(0.9999999999999999);
  });
  // v2=[0.1*(i+1) for i in range(200)]; np.sum(v2), np.mean(v2), np.std(v2), np.std(v2, ddof=1)
  it('npSum / npMean / npStd on 200 elements (recursive pairwise blocks)', () => {
    const v2 = Array.from({ length: 200 }, (_, i) => 0.1 * (i + 1));
    expect(S.npSum(v2)).toBe(2010.0);
    expect(S.npMean(v2)).toBe(10.05);
    expect(S.npStd(v2)).toBe(5.773430522661549);
    expect(S.npStd(v2, 1)).toBe(5.787918451395114);
  });
  // np.array([2,4,4,4,5,5,7,9.]).std() == 2.0 ; pd.Series([1.0,nan,2.0]).mean() == 1.5
  it('npStd textbook case, seriesMean skips NaN', () => {
    expect(S.npStd([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2.0);
    expect(S.seriesMean([1, N, 2])).toBe(1.5);
  });
  // pd.Series([1e16,1.0,-1e16,1.0]).groupby([0,0,0,0]).sum().iloc[0] == 1.0
  // pd.Series([1.0,1e100,1.0,-1e100]).groupby([0,0,0,0]).sum().iloc[0] == 0.0  (plain Kahan, not Neumaier)
  // pd.Series([0.1]*10).groupby([0]*10).sum().iloc[0] == 1.0
  it('kahanSum reproduces pandas group_sum', () => {
    expect(S.kahanSum([1e16, 1.0, -1e16, 1.0])).toBe(1.0);
    expect(S.kahanSum([1.0, 1e100, 1.0, -1e100])).toBe(0.0);
    expect(S.kahanSum(new Array(10).fill(0.1))).toBe(1.0);
  });
});

describe('elementwise helpers', () => {
  // np.linspace(0.0,1.0,5).tolist(); np.linspace(0.1,0.7,7).tolist()
  it('linspace', () => {
    expectExact(S.linspace(0, 1, 5), [0.0, 0.25, 0.5, 0.75, 1.0]);
    expectExact(S.linspace(0.1, 0.7, 7), [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
    expectExact(S.linspace(5, 5, 3), [5, 5, 5]);
  });
  // pd.Series([100.0,110.0,99.0,99.0]).pct_change().tolist(); pd.Series([100.0,110.0,99.0]).diff().tolist()
  it('pctChange (x/prev − 1) and diff', () => {
    expectExact(S.pctChange([100, 110, 99, 99]), [null, 0.10000000000000009, -0.09999999999999998, 0.0]);
    expectExact(S.diff([100, 110, 99]), [null, 10.0, -11.0]);
    expectExact(S.pctChange([100, N, 110]), [null, 0.0, 0.10000000000000009]); // pandas 2.3.3 pads
    expectExact(S.pctChange([100, N, 110], 1, null), [null, null, null]);
  });
  // h=[10,11,9.5]; l=[9,10,9]; c=[9.5,10.5,10.8]; pd.concat([(h-l),(h-c.shift(1)).abs(),(l-c.shift(1)).abs()],axis=1).max(axis=1).tolist()
  it('trueRange: first row = high − low (NaN skipped like DataFrame.max)', () => {
    expectExact(S.trueRange([10, 11, 9.5], [9, 10, 9], [9.5, 10.5, 10.8]), [1.0, 1.5, 1.5]);
  });
  // src=pd.Series([1.,2.,3.,4.], index=pd.to_datetime([0,100,200,300],unit='ms')); src.reindex(pd.to_datetime([0,49,50,51,150,250,400],unit='ms'), method='nearest').tolist()
  it('reindexNearest: ties go to the right neighbour, ends clamp', () => {
    expectExact(S.reindexNearest([0, 100, 200, 300], [1, 2, 3, 4], [0, 49, 50, 51, 150, 250, 400]), [1.0, 1.0, 2.0, 2.0, 3.0, 4.0, 4.0]);
  });
  it('shift / clip / fillna / replaceZeroNaN / cumsum', () => {
    expectExact(S.shift([1, 2, 3], 1), [null, 1, 2]);
    expectExact(S.shift([1, 2, 3], -1), [2, 3, null]);
    expectExact(S.clipLower([-1, 0, 2, N], 0), [0, 0, 2, null]);
    expectExact(S.neg(S.clipUpper([-1, 0, 2, N], 0)), [1, -0, -0, null]);
    expectExact(S.fillna([1, N, 3], 50), [1, 50, 3]);
    expectExact(S.replaceZeroNaN([1, 0, -0, 2]), [1, null, null, 2]);
    expectExact(S.cumsum([1, 2, 3]), [1, 3, 6]);
    expectExact(S.seriesCumsum([1, N, 3]), [1, null, 4]);
  });
});
