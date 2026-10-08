/**
 * layers.test.js — the M1 numeric primitives against the bot's own layer dumps
 * (tests/golden/dumps/*.json, produced by `make_golden.py --dump-zones
 * --dump-volume-ctx --dump-squeeze` on three fixtures with the pinned venv).
 *
 * Every value is recomputed from the same candle prefixes with series.js /
 * kde.js and compared after the fixture rounding (r10 = float(f"{x:.10g}")):
 *   squeeze    : BB width (rolling mean/std ddof=0), Series.quantile 15/30 %, SMA ATR 14/50, score
 *   volume_ctx : ewm(adjust=True) EMAs, SMA MAs, Wilder RSI/ATR, TR, shifted volume mean, ribbon, HTF state
 *   zones      : EMA ATR, strict-window pivots, KDE peaks (scipy), volume profile HVN/LVN
 * This is the "harness runs end-to-end on a fixture" check of M1: the engines of
 * M2–M6 build on exactly these columns.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import load from './load.js';
import S from '../../strategies/common/series.js';
import K from '../../strategies/common/kde.js';
import F from '../../strategies/common/pyfmt.js';

const { loadFrames, barInputs, GOLDEN_DIR } = load;
const { r10 } = F;
const DUMPS_DIR = path.join(GOLDEN_DIR, 'dumps');

function loadDump(name) {
  const file = path.join(DUMPS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const same = (a, b) => (b === null ? !(a === a) || a === null : r10(a) === b);
const last = (arr) => arr[arr.length - 1];

function expectLayer(failures, max = 12) {
  if (failures.length) throw new Error(`${failures.length} mismatches:\n${failures.slice(0, max).join('\n')}`);
}

const RIBBON_SPANS = [5, 9, 14, 20, 27, 35, 44, 55];

/** volume_strategy.htf_state / _htf_state_arrays for the last bar. */
function htfState(dfHtf, htfEma = 50, slopeBars = 3) {
  if (!dfHtf || dfHtf.length < Math.floor(htfEma / 2) + slopeBars + 1) return 0;
  const e = S.ewmSpanAdjust(dfHtf.c, htfEma);
  const n = e.length;
  const side = Math.sign(dfHtf.c[n - 1] - e[n - 1]);
  const prev = n > slopeBars ? e[n - 1 - slopeBars] : Number.NaN;
  let d = e[n - 1] - prev;
  if (d !== d) d = 0;
  const slope = Math.sign(d);
  const strong = side !== 0 && slope === side;
  return side * (strong ? 2 : 1);
}

/** squeeze_detector.compute_squeeze_score internals. */
function squeeze(df) {
  const n = df.length;
  const rec = { n, score: 0, bbw_last: null, thr_strong: null, thr_some: null, atr14: null, atr50: null, atr_ratio: null };
  if (n < Math.max(50 + 21, 51)) return rec;
  const sma = S.rollingMean(df.c, 20), std = S.rollingStd(df.c, 20, 0);
  const width = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const upper = sma[i] + 2.0 * std[i];
    const lower = sma[i] - 2.0 * std[i];
    width[i] = (upper - lower) / (sma[i] === 0 ? Number.NaN : sma[i]);
  }
  const bbw = width.filter((v) => v === v);
  if (bbw.length < 50) return rec;
  const recent = bbw.subarray(bbw.length - 50);
  rec.bbw_last = bbw[bbw.length - 1];
  rec.thr_strong = S.seriesQuantile(recent, 0.15);
  rec.thr_some = S.seriesQuantile(recent, 0.30);
  rec.bbw_recent = Array.from(recent);
  const atr14 = S.atrSma(df.h, df.l, df.c, 14).filter((v) => v === v);
  const atr50 = S.atrSma(df.h, df.l, df.c, 50).filter((v) => v === v);
  if (!atr14.length || !atr50.length) return rec;
  rec.atr14 = last(atr14); rec.atr50 = last(atr50);
  rec.atr_ratio = last(atr14) / Math.max(last(atr50), 1e-9);
  const bbStrong = rec.bbw_last <= rec.thr_strong, bbSome = rec.bbw_last <= rec.thr_some;
  const atrStrong = rec.atr_ratio <= 0.7, atrSome = rec.atr_ratio <= 0.85;
  if (bbStrong && atrStrong) rec.score = 2;
  else if (bbSome && atrSome) rec.score = 1;
  else if (bbSome || atrSome) rec.score = 1;
  return rec;
}

describe('M1 primitives vs bot layer dumps', () => {
  const sq = loadDump('squeeze');
  const vc = loadDump('volume_ctx');
  const zn = loadDump('zones');

  (sq ? it : it.skip)('squeeze detector internals (bbw, quantiles, SMA ATR, score) are r10-identical', () => {
    const failures = [];
    for (const [symbol, bars] of Object.entries(sq.fixtures)) {
      const frames = loadFrames(symbol);
      for (const [iStr, want] of Object.entries(bars)) {
        const b = barInputs(frames, Number(iStr));
        const got = squeeze(b.df);
        for (const k of ['n', 'score']) if (got[k] !== want[k]) failures.push(`${symbol} bar ${iStr} ${k}: ${got[k]} != ${want[k]}`);
        for (const k of ['bbw_last', 'thr_strong', 'thr_some', 'atr14', 'atr50', 'atr_ratio']) {
          if (!same(got[k], want[k])) failures.push(`${symbol} bar ${iStr} ${k}: ${got[k]} (r10 ${r10(got[k])}) != ${want[k]}`);
        }
        if (want.bbw_recent) {
          for (let j = 0; j < 50; j++) {
            if (!same(got.bbw_recent[j], want.bbw_recent[j])) { failures.push(`${symbol} bar ${iStr} bbw_recent[${j}]: ${got.bbw_recent[j]} != ${want.bbw_recent[j]}`); break; }
          }
        }
      }
    }
    expectLayer(failures);
  });

  (vc ? it : it.skip)('VOLUME context columns at the last bar are r10-identical', () => {
    const cfg = vc.volume_config;
    const failures = [];
    for (const [symbol, bars] of Object.entries(vc.fixtures)) {
      const frames = loadFrames(symbol);
      for (const [iStr, want] of Object.entries(bars)) {
        const b = barInputs(frames, Number(iStr));
        const df = b.df;
        const ma = (n) => (cfg.ma_type === 'ema' ? S.ewmSpanAdjust(df.c, n) : S.sma(df.c, n));
        const vavg = last(S.volumeAvgExcludingLast(df.v, cfg.vol_len));
        let vr = vavg > 0 ? last(df.v) / vavg : 0.0;
        if (vr !== vr) vr = 0.0;
        const got = {
          n: df.length,
          e50: last(S.ewmSpanAdjust(df.c, cfg.ema_mid)), e200: last(S.ewmSpanAdjust(df.c, cfg.ema_trend)),
          maF: last(ma(cfg.ma_fast)), maM: last(ma(cfg.ma_mid)), maS: last(ma(cfg.ma_slow)), turn: last(ma(cfg.turn_period)),
          rsi: last(S.rsiWilder(df.c, cfg.rsi_period)), atr: last(S.atrWilder(df.h, df.l, df.c, cfg.atr_period)),
          tr: last(S.trueRange(df.h, df.l, df.c)), vavg, vr,
          rib: RIBBON_SPANS.map((n) => last(S.ewmSpanAdjust(df.c, n))),
          htf_state: cfg.use_htf ? htfState(b.dfHtf4h, cfg.htf_ema) : 0,
          n_htf_bars: cfg.use_htf && b.dfHtf4h ? b.dfHtf4h.length : 0,
          candidate: vr >= (1.0 - 1e-9),
        };
        for (const k of ['n', 'htf_state', 'n_htf_bars', 'candidate']) if (got[k] !== want[k]) failures.push(`${symbol} bar ${iStr} ${k}: ${got[k]} != ${want[k]}`);
        for (const k of ['e50', 'e200', 'maF', 'maM', 'maS', 'turn', 'rsi', 'atr', 'tr', 'vavg', 'vr']) {
          if (!same(got[k], want[k])) failures.push(`${symbol} bar ${iStr} ${k}: ${got[k]} (r10 ${r10(got[k])}) != ${want[k]}`);
        }
        for (let j = 0; j < RIBBON_SPANS.length; j++) {
          if (!same(got.rib[j], want.rib[j])) failures.push(`${symbol} bar ${iStr} rib[${j}]: ${got.rib[j]} != ${want.rib[j]}`);
        }
      }
    }
    expectLayer(failures);
  });

  (zn ? it : it.skip)('LEVELS zone layers (ATR, pivots, KDE peaks, volume profile) match', () => {
    const ic = zn.ind_config;
    const s = ic.PIVOT_STRENGTH;
    const failures = [];
    let kdeBars = 0;
    for (const [symbol, bars] of Object.entries(zn.fixtures)) {
      const frames = loadFrames(symbol);
      for (const [iStr, want] of Object.entries(bars)) {
        const b = barInputs(frames, Number(iStr));
        const df = b.df;
        const n = df.length;
        const atrNow = last(S.atrEmaSpan(df.h, df.l, df.c, ic.ATR_PERIOD));
        if (!same(atrNow, want.atr_now)) failures.push(`${symbol} bar ${iStr} atr_now: ${atrNow} != ${want.atr_now}`);
        const res = [], sup = [];
        for (let k = s; k < n - s; k++) {
          let hi = -Infinity, lo = Infinity;
          for (let j = k - s; j <= k + s; j++) { if (df.h[j] > hi) hi = df.h[j]; if (df.l[j] < lo) lo = df.l[j]; }
          if (df.h[k] === hi) res.push([df.h[k], n - 1 - k]);
          if (df.l[k] === lo) sup.push([df.l[k], n - 1 - k]);
        }
        const pivEq = (got, exp) => got.length === exp.length && got.every((p, j) => r10(p[0]) === exp[j][0] && p[1] === exp[j][1]);
        if (!pivEq(res, want.pivots_res)) failures.push(`${symbol} bar ${iStr} pivots_res differ: ${JSON.stringify(res.map((p) => [r10(p[0]), p[1]]))} vs ${JSON.stringify(want.pivots_res)}`);
        if (!pivEq(sup, want.pivots_sup)) failures.push(`${symbol} bar ${iStr} pivots_sup differ`);
        const priceRange = [S.seriesMin(df.l), S.seriesMax(df.h)];
        if (r10(priceRange[0]) !== want.price_range[0] || r10(priceRange[1]) !== want.price_range[1]) failures.push(`${symbol} bar ${iStr} price_range`);
        const allPivots = res.concat(sup).map((p) => p[0]);
        const peaks = K.kdeLevels(allPivots, priceRange);
        const peaksR = peaks.map(r10);
        if (JSON.stringify(peaksR) !== JSON.stringify(want.kde_peaks)) failures.push(`${symbol} bar ${iStr} kde_peaks: ${JSON.stringify(peaksR)} != ${JSON.stringify(want.kde_peaks)}`);
        if (want.kde_peaks.length) kdeBars++;
        const vp = K.volumeProfile(df.l, df.h, df.v, 50);
        if (JSON.stringify(vp.hvn.map(r10)) !== JSON.stringify(want.hvn)) failures.push(`${symbol} bar ${iStr} hvn differ`);
        if (JSON.stringify(vp.lvn.map(r10)) !== JSON.stringify(want.lvn)) failures.push(`${symbol} bar ${iStr} lvn differ`);
        for (let j = 0; j < 50; j++) if (!same(vp.volumes[j], want.vp_volumes[j])) { failures.push(`${symbol} bar ${iStr} vp_volumes[${j}]: ${vp.volumes[j]} != ${want.vp_volumes[j]}`); break; }
      }
    }
    expectLayer(failures);
    expect(kdeBars).toBeGreaterThan(100);
  });
});
