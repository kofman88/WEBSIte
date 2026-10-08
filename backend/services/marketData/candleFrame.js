'use strict';
/**
 * candleFrame.js — the candle normalisation of the bot (`fetcher_bingx._rows_to_df`)
 * producing the engine `Frame` (open_time ms index, ascending, LAST ROW = LAST CLOSED
 * BAR, volume in USDT, prices in OKX units) plus the timeframe tables shared by the
 * REST client, the WS feed and the caches.
 *
 * Python-faithful parsing: rows are parsed with `int()` / `float()` semantics
 * (unparsable rows are skipped, "inf"/"nan" are floats that are dropped later).
 */

const { Frame } = require('../../strategies/common/frame');
const { ND_DIGIT, PY_SPACE } = require('../engine/pyUnicode');

// BingX interval strings — all lower-case except 1M.
const TF_TO_BINGX = Object.freeze({
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '12h': '12h',
  '1d': '1d', '1w': '1w', '1M': '1M',
  '1H': '1h', '2H': '2h', '4H': '4h', '6H': '6h', '12H': '12h',
  '1D': '1d', '1W': '1w',
});

// Bar length per BingX interval. 1M = 31 days: a short month is considered closed
// 1–3 days late, but a forming monthly bar never lands among the closed ones.
const TF_MS = Object.freeze({
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '6h': 21_600_000, '12h': 43_200_000, '1d': 86_400_000,
  '1w': 604_800_000,
  '1M': 2_678_400_000,
});
const DEFAULT_TF_MS = 3_600_000;
const MAX_KLINES = 1440;

/** ws_feed._TF_NORM — cache/WS key timeframe (1h → 1H, 4h → 4H, 1d → 1D). */
const TF_NORM = Object.freeze({
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1H', '1H': '1H', '2h': '2H', '2H': '2H',
  '4h': '4H', '4H': '4H', '1d': '1D', '1D': '1D',
});

/** ws_feed._TTL_MAP (seconds) — TTL for WS/warmer written cache entries. */
const TTL_MAP = Object.freeze({
  '1m': 300, '3m': 900, '5m': 1800, '15m': 3600, '30m': 7200,
  '1H': 14400, '1h': 14400, '2H': 28800, '2h': 28800,
  '4H': 57600, '4h': 57600, '1D': 172800, '1d': 172800,
});

/** Config.CACHE_TTL — TTL used by the scanners' REST fallbacks. */
const CACHE_TTL = Object.freeze({
  '1m': 55, '5m': 270, '15m': 870, '30m': 1770, '1h': 3570, '4h': 14370,
  '1d': 85000, '1D': 85000, '1H': 3570, '4H': 14370,
});

/** ws_feed_bingx._TF_NORM_TO_BINGX — cache key tf → BingX interval. */
const TF_NORM_TO_BINGX = Object.freeze({
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1H': '1h', '2H': '2h', '4H': '4h', '6H': '6h', '12H': '12h',
  '1D': '1d', '1W': '1w',
});
const BINGX_TO_TF_NORM = Object.freeze(Object.fromEntries(Object.entries(TF_NORM_TO_BINGX).map(([k, v]) => [v, k])));

function tfNorm(tf) { return TF_NORM[tf] ?? tf; }
function tfMsBingx(tfBingx) { return TF_MS[tfBingx] ?? DEFAULT_TF_MS; }

// ── Python number parsing ───────────────────────────────────────────────────

class PyValueError extends Error {}

// Python's `int()` / `float()` string grammar: optional sign, decimal digits of ANY Unicode
// script (category Nd of the bot's Unicode database, CPython 3.11 = unicodedata 14.0.0:
// fullwidth, Arabic-Indic, … but not the Kawi / Nag Mundari digits of Unicode 15), single
// underscores only BETWEEN digits ("1_0" ok, "1__0" / "_10" / "10_" raise), surrounding
// whitespace ignored; floats add the fraction / exponent (underscores allowed inside each
// digit run) and the inf / nan words.
const INT_RE = /^[+-]?\d(?:_?\d)*$/;
const FLOAT_RE = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:e[+-]?\d(?:_?\d)*)?$/;

/** Every Unicode decimal digit (the bot's Nd table) → its ASCII digit; anything else is kept. */
function asciiDigits(s) {
  let out = '';
  for (const ch of s) {
    const d = ND_DIGIT.get(ch.codePointAt(0));
    out += d === undefined ? ch : String(d);
  }
  return out;
}

/**
 * The text int() / float() parse (_PyUnicode_TransformDecimalAndSpaceToASCII): a non-ASCII
 * str.isspace() character reads as ' ', a decimal digit as its ASCII digit, then only the ASCII
 * whitespace " \t\n\v\f\r" is stripped (U+FEFF and \x1c–\x1f are no number whitespace).
 */
function numText(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += c >= 0x80 && PY_SPACE.has(c) ? ' ' : ch;
  }
  return asciiDigits(out).replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '');
}

/** Python `int(x)`: ints, floats (truncated), integer strings; anything else throws. */
function pyInt(x) {
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new PyValueError(`cannot convert ${x} to int`);
    return Math.trunc(x);
  }
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'bigint') return Number(x);
  if (typeof x === 'string') {
    const s = numText(x);
    if (!INT_RE.test(s)) throw new PyValueError(`invalid literal for int() with base 10: ${JSON.stringify(x)}`);
    return Number(s.replace(/_/g, ''));
  }
  throw new PyValueError(`int() argument must be a number, not ${x === null ? 'NoneType' : typeof x}`);
}

/** Python `float(x)`: numbers, numeric strings incl. inf/nan; '' / None / objects throw. */
function pyFloat(x) {
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'bigint') return Number(x);
  if (typeof x === 'string') {
    const s = numText(x).toLowerCase();
    if (s === '') throw new PyValueError('could not convert string to float: \'\'');
    if (s === 'inf' || s === '+inf' || s === 'infinity' || s === '+infinity') return Infinity;
    if (s === '-inf' || s === '-infinity') return -Infinity;
    if (s === 'nan' || s === '+nan' || s === '-nan') return NaN;
    if (!FLOAT_RE.test(s)) throw new PyValueError(`could not convert string to float: ${JSON.stringify(x)}`);
    return Number(s.replace(/_/g, ''));
  }
  throw new PyValueError(`float() argument must be a string or a real number, not ${x === null ? 'NoneType' : typeof x}`);
}

/** Python truthiness of a JSON-ish value (for `x or 0`). */
function pyFalsy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return true;
  if (typeof v === 'number') return Number.isNaN(v) ? false : v === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// ── _rows_to_df ─────────────────────────────────────────────────────────────

/** One kline row (dict or list) → [t, o, h, l, c, v] or null when unparsable. */
function parseRow(r) {
  try {
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      let t = null;
      let found = false;
      for (const k of ['time', 'openTime', 'T']) {
        const v = r[k];
        if (v !== null && v !== undefined && v !== '') { t = pyInt(v); found = true; break; }
      }
      if (!found) return null; // StopIteration
      const o = pyFloat(r.open), h = pyFloat(r.high);
      const l = pyFloat(r.low), c = pyFloat(r.close);
      const vr = 'volume' in r ? r.volume : 0;
      const v = pyFloat(pyFalsy(vr) ? 0 : vr);
      return [t, o, h, l, c, v];
    }
    if (Array.isArray(r)) {
      const t = pyInt(r[0]);
      const o = pyFloat(r[1]), h = pyFloat(r[2]), l = pyFloat(r[3]), c = pyFloat(r[4]);
      const v = r.length > 5 ? pyFloat(r[5]) : 0.0;
      return [t, o, h, l, c, v];
    }
    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * `/v3/quote/klines` rows → Frame of CLOSED bars (≈ limit-1), or null when nothing
 * parses / everything is still forming. After the NaN/inf drop the frame may be empty
 * (pandas returns an empty DataFrame there, callers test `length > 0`).
 *
 * 1. parse (skip unparsable); 2. sort by t, dedup by t (last occurrence wins);
 * 3. drop forming: keep `t + tfMs <= nowMs`; 4. volume = v × close (BingX units =
 * USDT), then prices /= mult; 5. ±inf → NaN, drop rows with any NaN.
 */
function rowsToFrame(rows, tfBingx, mult, nowMs = Date.now()) {
  const recs = [];
  for (const r of rows || []) {
    const p = parseRow(r);
    if (p) recs.push(p);
  }
  if (!recs.length) return null;
  recs.sort((a, b) => a[0] - b[0]); // stable, like list.sort
  const dedup = new Map();
  for (const rec of recs) dedup.set(rec[0], rec); // last occurrence wins
  const keys = Array.from(dedup.keys()).sort((a, b) => a - b);
  const tfMs = tfMsBingx(tfBingx);
  const closed = [];
  for (const k of keys) {
    const rec = dedup.get(k);
    if (rec[0] + tfMs <= nowMs) closed.push(rec);
  }
  if (!closed.length) return null;
  const bars = [];
  const m = Number(mult);
  const scale = m && m !== 1.0;
  for (const [t, o, h, l, c, v] of closed) {
    const volume = v * c; // USDT in BingX units — not scaled
    let oo = o, hh = h, ll = l, cc = c;
    if (scale) { oo = o / m; hh = h / m; ll = l / m; cc = c / m; }
    const vals = [oo, hh, ll, cc, volume];
    if (vals.some((x) => !Number.isFinite(x))) continue; // ±inf → NaN → dropna
    bars.push([t, oo, hh, ll, cc, volume]);
  }
  return Frame.fromBars(bars);
}

// ── in-place helpers for the WS cache update (`ws_feed._update_cache`) ──────

/** Binary search for open-time `tMs` → index or -1. */
function frameIndexOf(frame, tMs) {
  const t = frame.t;
  let lo = 0, hi = t.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (t[mid] === tMs) return mid;
    if (t[mid] < tMs) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/** `existing.loc[ts, cols] = [...]` — overwrite row `idx` in place. */
function frameSetRow(frame, idx, o, h, l, c, v) {
  frame.o[idx] = o; frame.h[idx] = h; frame.l[idx] = l; frame.c[idx] = c; frame.v[idx] = v;
  return frame;
}

/** `pd.concat([existing, new_row])` — a new Frame with the bar appended (keeps order by open-time). */
function frameAppendRow(frame, tMs, o, h, l, c, v) {
  const n = frame.length;
  // concat appends at the end; the WS only appends newer bars, but keep the index sorted
  // defensively (pandas would leave it unsorted — same data, index order only matters for -1).
  let pos = n;
  while (pos > 0 && frame.t[pos - 1] > tMs) pos--;
  const mk = (src, val) => {
    const out = new Float64Array(n + 1);
    out.set(src.subarray(0, pos), 0);
    out[pos] = val;
    out.set(src.subarray(pos), pos + 1);
    return out;
  };
  const f = new Frame(mk(frame.t, tMs), mk(frame.o, o), mk(frame.h, h), mk(frame.l, l), mk(frame.c, c), mk(frame.v, v));
  f.symbol = frame.symbol; f.tf = frame.tf;
  return f;
}

/** `existing.iloc[-n:]` materialised (so the old buffer can be released). */
function frameTrim(frame, n = 300) {
  if (frame.length <= n) return frame;
  return frame.tail(n).copy();
}

module.exports = {
  TF_TO_BINGX, TF_MS, DEFAULT_TF_MS, MAX_KLINES, TF_NORM, TTL_MAP, CACHE_TTL,
  TF_NORM_TO_BINGX, BINGX_TO_TF_NORM, tfNorm, tfMsBingx,
  pyInt, pyFloat, pyFalsy, asciiDigits, PyValueError, parseRow, rowsToFrame,
  frameIndexOf, frameSetRow, frameAppendRow, frameTrim,
};
