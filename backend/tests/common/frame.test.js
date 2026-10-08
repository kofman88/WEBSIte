/**
 * frame.js — candle frame type, closed-bar prefix rule of the golden generator, resampling.
 *
 * Reference (pandas 2.3.3): 8 bars of 15m starting at 1699999200000 (a UTC hour boundary),
 * volume = [1e16, 1.0, -1e16, 1.0, 0.1, 0.2, 0.3, 0.4];
 *   df15.resample('1h', label='left', closed='left').agg(open=first, high=max, low=min, close=last, volume=sum)
 *   → index [1699999200000, 1700002800000]; open [10, 14]; high [14, 18]; low [9, 13]; close [13.5, 17.5]; volume [1.0, 1.0]
 */
import { describe, it, expect } from 'vitest';
import FR from '../../strategies/common/frame.js';

const { Frame, TF_MS, tfToMs, resample, auxFrame } = FR;

const H = 3_600_000;
function hourly(n, t0 = 1_700_000_000_000 - (1_700_000_000_000 % H)) {
  const bars = [];
  for (let i = 0; i < n; i++) bars.push([t0 + i * H, 10 + i, 11 + i, 9 + i, 10.5 + i, 100 + i]);
  return Frame.fromBars(bars);
}

describe('Frame basics', () => {
  it('fromBars / row / slice views / prefix / tail', () => {
    const f = hourly(10);
    expect(f.length).toBe(10);
    expect(f.row(0)).toEqual({ t: f.t[0], o: 10, h: 11, l: 9, c: 10.5, v: 100 });
    expect(f.row(-1).c).toBe(19.5);
    const p = f.prefix(4);
    expect(p.length).toBe(5);
    expect(p.c[4]).toBe(14.5);
    expect(p.c.buffer).toBe(f.c.buffer); // zero-copy view
    expect(f.tail(3).o[0]).toBe(17);
    expect(f.slice(-2).length).toBe(2);
    expect(f.slice(8, 100).length).toBe(2);
    expect(f.toBars()[1][0]).toBe(f.t[1]);
  });
  it('utcHour / utcDayOfWeek follow pandas (Monday = 0)', () => {
    const f = Frame.fromBars([[Date.UTC(2025, 11, 23, 16), 1, 1, 1, 1, 1], [Date.UTC(2025, 11, 28, 0), 1, 1, 1, 1, 1]]);
    expect(f.utcHour(0)).toBe(16);
    expect(f.utcHour(-1)).toBe(0);
    expect(f.utcDayOfWeek(0)).toBe(1); // Tuesday
    expect(f.utcDayOfWeek(1)).toBe(6); // Sunday
  });
  it('tfToMs accepts user and cache spellings', () => {
    expect(tfToMs('1h')).toBe(H);
    expect(tfToMs('1H')).toBe(H);
    expect(tfToMs('4H')).toBe(4 * H);
    expect(tfToMs('1D')).toBe(TF_MS['1d']);
    expect(tfToMs('15m')).toBe(900_000);
    expect(() => tfToMs('7x')).toThrow();
  });
});

describe('closed-bar prefix rule (make_golden.aligned_prefix)', () => {
  it('keeps bars with open_time + tf <= close_ms, last `window`', () => {
    const f = hourly(10);
    const closeMs = f.t[5] + H; // bar 5 just closed
    expect(f.countClosedAt(H, closeMs)).toBe(6);
    expect(f.closedPrefix('1h', closeMs).length).toBe(6);
    expect(f.closedPrefix('1h', closeMs, 4).length).toBe(4);
    expect(f.closedPrefix('1h', closeMs, 4).t[0]).toBe(f.t[2]);
    expect(f.closedPrefix('1h', closeMs - 1).length).toBe(5); // bar 5 not closed yet
    expect(f.closedPrefix('1h', f.t[0] + H - 1)).toBe(null); // nothing closed → None
    expect(f.lastClosedAt('1h', closeMs)).toBe(5);
    expect(auxFrame(f, '1h', closeMs, 300).length).toBe(6);
  });
  it('a 4h series against a 1h close time', () => {
    const t0 = 1_700_000_000_000 - (1_700_000_000_000 % (4 * H)) - 4 * 4 * H;
    const bars = [];
    for (let i = 0; i < 6; i++) bars.push([t0 + i * 4 * H, 1, 2, 0.5, 1.5, 10]);
    const f4 = Frame.fromBars(bars);
    // close at t0 + 4h + 1h → only the first 4h bar is closed
    expect(f4.closedPrefix('4h', t0 + 5 * H).length).toBe(1);
    expect(f4.closedPrefix('4h', t0 + 8 * H).length).toBe(2);
  });
});

describe('resample (pandas label=left, closed=left, Kahan volume sum)', () => {
  it('15m → 1h reproduces the pandas aggregation', () => {
    const t0 = 1699999200000;
    const vol = [1e16, 1.0, -1e16, 1.0, 0.1, 0.2, 0.3, 0.4];
    const bars = [];
    for (let i = 0; i < 8; i++) bars.push([t0 + 900_000 * i, 10 + i, 11 + i, 9 + i, 10.5 + i, vol[i]]);
    const f15 = Frame.fromBars(bars);
    const f1h = resample(f15, '1h');
    expect(Array.from(f1h.t)).toEqual([1699999200000, 1700002800000]);
    expect(Array.from(f1h.o)).toEqual([10, 14]);
    expect(Array.from(f1h.h)).toEqual([14, 18]);
    expect(Array.from(f1h.l)).toEqual([9, 13]);
    expect(Array.from(f1h.c)).toEqual([13.5, 17.5]);
    expect(Array.from(f1h.v)).toEqual([1.0, 1.0]);
  });
  it('partial first/last buckets are kept (like pandas) and 1h → 4h/1d buckets are day-anchored', () => {
    const f = hourly(30);
    const f4 = resample(f, '4h');
    expect(f4.t[0] % (4 * H)).toBe(0);
    const nBuckets = Math.floor(f.t[29] / (4 * H)) - Math.floor(f.t[0] / (4 * H)) + 1;
    expect(f4.length).toBe(nBuckets);
    expect(f4.o[0]).toBe(f.o[0]);
    expect(f4.c[f4.length - 1]).toBe(f.c[29]);
    const f1d = resample(f, '1d');
    expect(f1d.t[0] % TF_MS['1d']).toBe(0);
    const firstDayBars = Math.round((f1d.t[1] - f.t[0]) / H);
    expect(f1d.v[0]).toBe(f.v.subarray(0, firstDayBars).reduce((a, b) => a + b, 0));
    expect(f1d.h[0]).toBe(Math.max(...f.h.subarray(0, firstDayBars)));
  });
});
