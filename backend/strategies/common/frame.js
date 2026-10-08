'use strict';
/**
 * frame.js — the candle frame type used by every engine, mirroring the pandas
 * DataFrame convention of the bot (`fetcher.py` / golden `make_golden.load_df`):
 *   columns open/high/low/close/volume as float64, index = open_time (UTC ms),
 *   ascending, LAST ROW = LAST CLOSED BAR (the forming bar is never stored).
 *
 * A Frame is a struct of Float64Arrays { t, o, h, l, c, v } + length. Slices
 * are zero-copy views (Float64Array.subarray), so building the 200 prefix frames
 * of a golden sweep costs nothing.
 */

const { kahanSum } = require('./series');

const TF_MS = Object.freeze({
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000, '12h': 43_200_000,
  '1d': 86_400_000, '1w': 604_800_000,
});

/** '1h' / '1H' / '4H' / '1D' / '15m' → ms (case of the unit letter ignored). */
function tfToMs(tf) {
  if (typeof tf === 'number') return tf;
  const key = String(tf).trim().replace(/H$/, 'h').replace(/D$/, 'd').replace(/W$/, 'w').replace(/M$/, 'm');
  const ms = TF_MS[key];
  if (!ms) throw new Error(`unknown timeframe: ${tf}`);
  return ms;
}

class Frame {
  constructor(t, o, h, l, c, v) {
    this.t = t; this.o = o; this.h = h; this.l = l; this.c = c; this.v = v;
    this.length = t.length;
  }

  /** From rows [[open_time_ms, open, high, low, close, volume], ...] (ascending). */
  static fromBars(bars) {
    const n = bars.length;
    const t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n);
    const l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      t[i] = +b[0]; o[i] = +b[1]; h[i] = +b[2]; l[i] = +b[3]; c[i] = +b[4]; v[i] = +b[5];
    }
    return new Frame(t, o, h, l, c, v);
  }

  /** From a golden fixture object {symbol, tf, bars}. */
  static fromFixture(fx) {
    const f = Frame.fromBars(fx.bars);
    f.symbol = fx.symbol; f.tf = fx.tf;
    return f;
  }

  /** From columns (arrays or typed arrays). */
  static fromColumns({ t, o, h, l, c, v }) {
    const F = (x) => (x instanceof Float64Array ? x : Float64Array.from(x, Number));
    return new Frame(F(t), F(o), F(h), F(l), F(c), F(v));
  }

  /** Zero-copy view of rows [start, end) — like df.iloc[start:end]. */
  slice(start = 0, end = this.length) {
    const n = this.length;
    if (start < 0) start = Math.max(0, n + start);
    if (end < 0) end = Math.max(0, n + end);
    if (end > n) end = n;
    if (start > end) start = end;
    const f = new Frame(
      this.t.subarray(start, end), this.o.subarray(start, end), this.h.subarray(start, end),
      this.l.subarray(start, end), this.c.subarray(start, end), this.v.subarray(start, end),
    );
    f.symbol = this.symbol; f.tf = this.tf;
    return f;
  }

  /** df.iloc[:i+1] — the prefix ending at bar i (inclusive). */
  prefix(i) {
    return this.slice(0, i + 1);
  }

  /** df.iloc[-n:] */
  tail(n) {
    return this.slice(Math.max(0, this.length - n), this.length);
  }

  /** Number of bars whose close (open_time + tfMs) is ≤ closeMs (np.searchsorted side='right'). */
  countClosedAt(tfMs, closeMs) {
    const t = this.t;
    let lo = 0, hi = t.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (t[mid] + tfMs <= closeMs) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /**
   * make_golden.aligned_prefix: all bars CLOSED at closeMs (open_time + tf ≤ closeMs),
   * optionally only the last `window` of them. Empty → null (like the generator).
   */
  closedPrefix(tfMs, closeMs, window = null) {
    const n = this.countClosedAt(tfToMs(tfMs), closeMs);
    let sub = this.slice(0, n);
    if (window) sub = sub.tail(window);
    return sub.length ? sub : null;
  }

  /** Index of the last bar closed at closeMs, or −1. */
  lastClosedAt(tfMs, closeMs) {
    return this.countClosedAt(tfToMs(tfMs), closeMs) - 1;
  }

  /** df.index[i].hour (UTC). i may be negative (−1 = last bar). */
  utcHour(i = -1) {
    const idx = i < 0 ? this.length + i : i;
    return new Date(this.t[idx]).getUTCHours();
  }

  /** df.index[i].dayofweek (Monday = 0 … Sunday = 6, like pandas). */
  utcDayOfWeek(i = -1) {
    const idx = i < 0 ? this.length + i : i;
    return (new Date(this.t[idx]).getUTCDay() + 6) % 7;
  }

  /** Last bar's open-time ms. */
  lastOpenMs() { return this.length ? this.t[this.length - 1] : NaN; }

  /** Row i as a plain object. */
  row(i) {
    const idx = i < 0 ? this.length + i : i;
    return { t: this.t[idx], o: this.o[idx], h: this.h[idx], l: this.l[idx], c: this.c[idx], v: this.v[idx] };
  }

  /** Back to [[t,o,h,l,c,v],...]. */
  toBars() {
    const out = new Array(this.length);
    for (let i = 0; i < this.length; i++) out[i] = [this.t[i], this.o[i], this.h[i], this.l[i], this.c[i], this.v[i]];
    return out;
  }

  /** Materialise the views into fresh arrays (e.g. before storing). */
  copy() {
    const f = new Frame(this.t.slice(), this.o.slice(), this.h.slice(), this.l.slice(), this.c.slice(), this.v.slice());
    f.symbol = this.symbol; f.tf = this.tf;
    return f;
  }
}

/**
 * pandas df.resample(rule, label='left', closed='left').agg(open=first, high=max,
 * low=min, close=last, volume=sum).dropna() for rules that divide a UTC day
 * (origin='start_day' ⇒ bucket = floor(t / tfMs) · tfMs). Volume uses the Kahan
 * summation of pandas group_sum. Empty buckets are dropped.
 */
function resample(frame, tfMs) {
  const tf = tfToMs(tfMs);
  const n = frame.length;
  const t = [], o = [], h = [], l = [], c = [], v = [];
  let i = 0;
  while (i < n) {
    const bucket = Math.floor(frame.t[i] / tf) * tf;
    let j = i;
    let hi = -Infinity, lo = Infinity;
    const vols = [];
    while (j < n && Math.floor(frame.t[j] / tf) * tf === bucket) {
      const hh = frame.h[j], ll = frame.l[j];
      if (hh === hh && hh > hi) hi = hh;
      if (ll === ll && ll < lo) lo = ll;
      vols.push(frame.v[j]);
      j++;
    }
    t.push(bucket);
    o.push(frame.o[i]);
    h.push(hi === -Infinity ? NaN : hi);
    l.push(lo === Infinity ? NaN : lo);
    c.push(frame.c[j - 1]);
    v.push(kahanSum(vols));
    i = j;
  }
  const f = Frame.fromColumns({ t, o, h, l, c, v });
  f.symbol = frame.symbol;
  return f;
}

/**
 * The bot's live rule for auxiliary frames: bars with open_time + tf ≤ closeMs,
 * last `window` (W=300 = REST limit / WS cache depth).
 */
function auxFrame(frame, tf, closeMs, window = 300) {
  return frame.closedPrefix(tf, closeMs, window);
}

module.exports = { Frame, TF_MS, tfToMs, resample, auxFrame };
