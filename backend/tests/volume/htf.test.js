/**
 * HTF module — htf_for, _htf_state_arrays, htf_state, resample_htf (pandas bucket rules,
 * partial first bucket, trailing cut) and htf_state_series (backtest state per LTF bar).
 * Expected values from the bot (pins.json) and the VOLUME context dump (dumps/volume_ctx.json).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import V from '../../strategies/volume/index.js';
import F from './frames.js';
import P from './pins.js';
import load from '../golden/load.js';

const { pins } = P;
const { T0, H } = F;

/** Same bars as gen/gen_pins.py hourly(): [t, f, f+0.5, f−0.5, f, 100+j]. */
function hourly(n, f, start = T0) {
  return F.toFrame(Array.from({ length: n }, (_, j) => [start + j * H, f(j), f(j) + 0.5, f(j) - 0.5, f(j), 100 + j]));
}

describe('htfFor', () => {
  it('maps 15m→1h, 1h→4h, 4h→1d (case-insensitive), anything else → ""', () => {
    for (const [tf, want] of Object.entries(pins.htf_for)) expect(V.htfFor(tf)).toBe(want);
    expect(V.htfFor(null)).toBe('');
    expect(V.htfFor(undefined)).toBe('');
  });
});

describe('htfStateArrays', () => {
  it('±2 side+slope, ±1 side only, 0 on the EMA; slope needs 3 bars', () => {
    const close = [10, 11, 12, 11, 10, 9, 9, 9, 10, 12];
    const ema = [10, 10.5, 11, 11, 10.8, 10.5, 10.2, 10, 10, 10.5];
    expect(Array.from(V.htfStateArrays(close, ema))).toEqual(pins.htf_state_arrays);
    expect(pins.htf_state_arrays).toEqual([0, 1, 1, 0, -1, -2, -2, -2, 0, 2]);
    expect(Array.from(V.htfStateArrays([5, 5, 5, 5], [5, 5, 5, 5]))).toEqual(pins.htf_state_arrays_equal);
    expect(V.htfStateArrays([], []).length).toBe(0);
  });
});

describe('htfState (last HTF row)', () => {
  const cfg = new V.VolumeConfig();
  const S = pins.htf_state;
  it('needs htf_ema // 2 + 3 + 1 rows (29 for EMA50; 8 for EMA8)', () => {
    expect(V.htfState(hourly(28, (j) => 100 + j), cfg)).toBe(S['28_rows']);
    expect(V.htfState(hourly(29, (j) => 100 + j), cfg)).toBe(S['29_rows_up']);
    expect(V.htfState(hourly(29, (j) => 100 - j), cfg)).toBe(S['29_rows_down']);
    expect([S['28_rows'], S['29_rows_up'], S['29_rows_down']]).toEqual([0, 2, -2]);
    const c8 = V.VolumeConfig.fromParams({ htf_ema: 8 });
    expect(V.htfState(hourly(7, (j) => 100 + j), c8)).toBe(S.htf_ema_8_rows_7);
    expect(V.htfState(hourly(8, (j) => 100 + j), c8)).toBe(S.htf_ema_8_rows_8);
    expect(V.htfState(null, cfg)).toBe(S.none);
  });
  it('price under a still-rising EMA on the last bar → −2 (EMA slope only; the "dip" bar drags the EMA down)', () => {
    expect(V.htfState(hourly(60, (j) => (j < 59 ? 100 + j : 100)), cfg)).toBe(S['60_rows_up_then_dip']);
    expect(S['60_rows_up_then_dip']).toBe(-2);
  });
  it('matches the bot dump (dumps/volume_ctx.json) on the 4h aligned prefixes', () => {
    const file = path.join(load.GOLDEN_DIR, 'dumps', 'volume_ctx.json');
    if (!fs.existsSync(file)) return;
    const vc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const c = V.VolumeConfig.fromParams({});
    for (const [symbol, bars] of Object.entries(vc.fixtures)) {
      const frames = load.loadFrames(symbol);
      for (const [iStr, want] of Object.entries(bars)) {
        if (Number(iStr) % 7 !== 0) continue;
        const b = load.barInputs(frames, Number(iStr));
        expect(V.htfState(b.dfHtf4h, c)).toBe(want.htf_state);
      }
    }
  });
});

describe('resampleHtf (pandas resample label=left, closed=left, origin=start_day + trailing cut)', () => {
  const R = pins.resample;
  const asCols = (f) => ({ t: Array.from(f.t), o: Array.from(f.o), h: Array.from(f.h), l: Array.from(f.l), c: Array.from(f.c), v: Array.from(f.v) });
  it('hourly bars from 02:00 → the 00:00 bucket is built from 2 bars (partial first bucket), only closed buckets kept', () => {
    const agg = V.resampleHtf(hourly(14, (j) => 100 + j, T0 + 2 * H), '1h');
    expect(asCols(agg)).toEqual(R.from_02_14bars);
    expect(agg.length).toBe(4);
    expect(R.from_02_14bars.v).toEqual([201, 414, 430, 446]);   // 2 + 4 + 4 + 4 bars
    const agg16 = V.resampleHtf(hourly(16, (j) => 100 + j, T0 + 2 * H), '1h');
    expect(agg16.length).toBe(R.from_02_16bars_n);
    expect(agg16.t[agg16.length - 1]).toBe(R.from_02_16bars_last_t);   // the 16:00 bucket is not closed at 18:00
    const agg3 = V.resampleHtf(hourly(3, (j) => 100 + j, T0 + 2 * H), '1h');
    expect(agg3.length).toBe(R.from_02_3bars);
  });
  it('empty frame / unknown timeframe → null; 15m → 1h (volume = Kahan sum)', () => {
    expect(V.resampleHtf(hourly(0, (j) => j), '1h')).toBe(R.empty);
    expect(V.resampleHtf(hourly(5, (j) => j), '1d')).toBe(R.unknown_tf);
    expect(V.resampleHtf(null, '1h')).toBeNull();
    const q = F.toFrame(Array.from({ length: 10 }, (_, j) => [T0 + j * 900000, 1 + j, 2 + j, 0.5 + j, 1.5 + j, 10]));
    const agg = V.resampleHtf(q, '15m');
    expect({ t: Array.from(agg.t), o: Array.from(agg.o), c: Array.from(agg.c), v: Array.from(agg.v) }).toEqual(R['15m_to_1h']);
  });
});

describe('htfStateSeries (backtest HTF state per LTF bar)', () => {
  const cfg = new V.VolumeConfig();
  it('400 hourly bars from 01:00 → 4h buckets; state only from bucket index htf_ema // 2; no look-ahead', () => {
    const path_ = (j) => (j < 200 ? 100 + 0.2 * j : 140 - 0.3 * (j - 200));
    const ser = V.htfStateSeries(hourly(400, path_, T0 + H), '1h', cfg);
    const want = pins.htf_state_series;
    expect(ser.length).toBe(want.n);
    expect(Array.from(ser)).toEqual(want.values);
    expect(ser.findIndex((v) => v !== 0)).toBe(want.first_nonzero);
    expect(want.first_nonzero).toBe(102);   // bucket 25 closes at 01:00 + 102 h
  });
  it('fewer than 3 buckets → null; 15m → 1h buckets', () => {
    expect(V.htfStateSeries(hourly(5, (j) => j), '1h', cfg)).toBe(pins.htf_state_series_short);
    const q = F.toFrame(Array.from({ length: 130 }, (_, j) => [T0 + j * 900000, 100 + j, 101 + j, 99 + j, 100 + j, 1]));
    expect(Array.from(V.htfStateSeries(q, '15m', cfg))).toEqual(pins.htf_state_series_15m);
    expect(V.htfStateSeries(q, '1d', cfg)).toBeNull();
  });
});
