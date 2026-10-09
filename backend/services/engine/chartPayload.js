'use strict';
/**
 * chartPayload.js — decision D3: the bot's chart_renderer.render_signal_chart /
 * render_progress_chart draw a PNG on the server; the site sends the same picture as data and
 * frontend/app/chart.js draws it on a canvas. This module is the data half of
 * render_signal_chart, step for step (chart_renderer.py lines 828–915), so every decision the
 * renderer takes on the bot is taken here on the same inputs:
 *
 *   • < 10 bars, missing OHLC                      → null (the bot returns None → "no_data")
 *   • tier: free 80 bars / no MAs, pro 110 bars + MAs (20/50/200 EMA; VOLUME SMA 10/20/50 + EMA 200,
 *     `extra.ema_periods` overrides), computed on the FULL frame and clipped to the window, the
 *     first p−1 values blank (warm-up), periods longer than the frame skipped
 *   • progress mode (event / hit_levels / be_price > 0): the window grows to include the entry
 *     bar (≤ 200 bars, entry bar = last bar with open_time ≤ entry_time) or, without an
 *     entry_time, the bot's _guess_entry_idx heuristic
 *   • the window is coerced to numbers and forward / back filled like pandas ffill().bfill()
 *   • [CHART-PMULT-MISMATCH]: max(entry, last close) / min(…) > 5 → null + the bot's WARNING
 *   • entry ≤ 0 → the last close; timeframe label = _tf_label(median bar interval) or the given TF
 *
 * Output (JSON-safe: NaN → null):
 *   { timeframe, meta: { symbol ("BTC/USDT"), strategy, direction, quality, score },
 *     candles: [[open_time_ms, open, high, low, close, volume], …]   (the drawn window, ascending)
 *     overlays: { entry, sl, tps: [tp1, tp2, tp3], be: be_price | null,
 *                 ob: [], fvg: [], pivots: [], hvn: [], lvn: [],      (zones / levels the caller passed)
 *                 emas: [{ name: "20", label: "EMA 20", kind: "EMA", period: 20, values: [...] }] },
 *     event, hit_levels, entry_index (the bar the position tool starts at), last_close }
 */

const { Frame } = require('../../strategies/common/frame');
const { ewmSpan, rollingMean } = require('../../strategies/common/series');
const { pyUpper, pyStrip } = require('../../strategies/common/pyUnicode');
const { fmtFixed } = require('../../strategies/common/pyfmt');

const TIER_FEATURES = Object.freeze({
  free: Object.freeze({ bars: 80, ema: false, pivot: false, vp: false }),
  pro: Object.freeze({ bars: 110, ema: true, pivot: true, vp: true }),
});

const isNone = (v) => v === null || v === undefined;
/** Python truthiness of a scalar / list argument. */
const truthy = (v) => !(isNone(v) || v === false || v === 0 || v === '' || (Array.isArray(v) && !v.length));
/** float(x or 0) */
const f0 = (v) => (truthy(v) ? Number(v) : 0);

/** _features_for_tier(tier): everything but "free" is pro. */
function featuresForTier(tier) {
  const t = String(tier || 'pro').toLowerCase();
  return TIER_FEATURES[t === 'free' ? 'free' : 'pro'];
}

/** _norm_symbol: ETH-USDT-SWAP / ETHUSDT / ETH/USDT → 'ETH/USDT'. */
function normSymbol(symbol) {
  const s = pyStrip(pyUpper(String(symbol || '')).split('-SWAP').join('').split('_').join('-'));
  if (s.includes('/')) return s;
  if (s.includes('-')) {
    const parts = s.split('-').filter((p) => p);
    return parts.length >= 2 ? parts.slice(0, 2).join('/') : s;
  }
  for (const quote of ['USDT', 'USDC', 'USD']) {
    if (s.endsWith(quote) && s.length > quote.length) return `${s.slice(0, -quote.length)}/${quote}`;
  }
  return s;
}

/** _bar_seconds(times): median positive interval (s, floor of the ns diff), int(). */
function barSeconds(tMs) {
  if (!tMs || tMs.length < 2) return null;
  const diffs = [];
  for (let i = 1; i < tMs.length; i++) {
    const d = Math.floor((tMs[i] - tMs[i - 1]) / 1000);   // (ns diff) // 10**9 on whole-ms stamps
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return null;
  diffs.sort((a, b) => a - b);
  const m = diffs.length >> 1;
  const med = diffs.length % 2 ? diffs[m] : (diffs[m - 1] + diffs[m]) / 2;
  return Math.trunc(med);
}

/** _tf_label(bar_sec): 3600 → '1h', 900 → '15m', 86400 → '1D'. */
function tfLabel(barSec) {
  if (!barSec) return '';
  if (barSec % 604800 === 0) return `${barSec / 604800}W`;
  if (barSec % 86400 === 0) return `${barSec / 86400}D`;
  if (barSec % 3600 === 0) return `${barSec / 3600}h`;
  if (barSec % 60 === 0) return `${barSec / 60}m`;
  return `${barSec}s`;
}

/** _calc_emas(full_close, periods) → [[label, Float64Array]] (int → EMA, "S10"/"E200" → SMA/EMA). */
function calcEmas(close, periods) {
  const out = [];
  for (let p of periods) {
    let kind = 'EMA';
    if (typeof p === 'string' && ['S', 'E'].includes(pyUpper(p.slice(0, 1)))) {
      kind = pyUpper(p.slice(0, 1)) === 'S' ? 'SMA' : 'EMA';
      p = p.slice(1);
    }
    let n;
    if (typeof p === 'number' && Number.isFinite(p)) n = Math.trunc(p);
    else if (typeof p === 'string' && /^\s*[+-]?\d+\s*$/.test(p)) n = parseInt(p, 10);
    else continue;
    if (n > 0 && close.length >= n) {
      let ma;
      if (kind === 'SMA') {
        ma = rollingMean(close, n);
      } else {
        ma = Float64Array.from(ewmSpan(close, n));
        for (let i = 0; i < Math.min(n - 1, ma.length); i++) ma[i] = NaN;   // warm-up не рисуем
      }
      out.push({ label: `${kind} ${n}`, kind, period: n, values: ma });
    }
  }
  return out;
}

/** df[col].ffill().bfill() of one column (NaN = missing). */
function fillCol(src) {
  const a = Float64Array.from(src);
  let last = NaN;
  for (let i = 0; i < a.length; i++) { if (a[i] === a[i]) last = a[i]; else a[i] = last; }
  let next = NaN;
  for (let i = a.length - 1; i >= 0; i--) { if (a[i] === a[i]) next = a[i]; else a[i] = next; }
  return a;
}

/** np.nonzero(cond)[0] helpers over typed arrays. */
function lastIndex(n, pred) { for (let i = n - 1; i >= 0; i--) if (pred(i)) return i; return -1; }

/** _guess_entry_idx(df, entry, hit_prices): the last bar touching entry before the last hit, else n−25. */
function guessEntryIdx(win, entry, hitPrices) {
  const n = win.length;
  const { h, l } = win;
  let limit = n - 1;
  for (const [price, above] of hitPrices) {
    const idx = lastIndex(n, (i) => (above ? h[i] >= price : l[i] <= price));
    if (idx !== -1) limit = Math.min(limit, idx);
  }
  const touch = [];
  for (let i = 0; i <= limit; i++) if (l[i] <= entry && h[i] >= entry) touch.push(i);
  if (touch.length) {
    if (limit < n - 1) return touch[touch.length - 1];
    const cand = touch.filter((i) => i <= n - 3);
    if (cand.length) return cand[cand.length - 1];
  }
  return Math.max(0, n - 25);
}

const jnum = (x) => (Number.isFinite(x) || x === Infinity || x === -Infinity ? x : null);
const jarr = (a) => Array.from(a, (x) => (x === x ? x : null));

/**
 * render_signal_chart(df, …) without the drawing: the payload, or null where the bot returns None.
 * `frame` is an engine Frame (open_time ms index); `log` gets the bot's warning lines.
 */
function chartPayload(frame, opts = {}, log = null) {
  const {
    symbol = '', strategy: strategyIn = 'LEVELS', quality = '', score = 0.0,
    extra = null, tier = 'pro', timeframe = '', event = '', hit_levels: hitLevels = null,
    be_price: bePrice = null, entry_time: entryTime = null,
  } = opts;
  if (!frame || frame.length < 10) return null;
  const feats = featuresForTier(tier);
  const direction = pyUpper(String(opts.direction || 'LONG'));
  const strategy = pyUpper(String(strategyIn || ''));
  const progress = Boolean(truthy(event) || truthy(hitLevels) || (truthy(bePrice) && bePrice > 0));
  let entry = f0(opts.entry);
  const sl = f0(opts.sl);
  const tp1 = f0(opts.tp1); const tp2 = f0(opts.tp2); const tp3 = f0(opts.tp3);
  const full = frame instanceof Frame ? frame : Frame.fromColumns(frame);
  const N = full.length;
  const haveTimes = N >= 2 && Array.from(full.t).every((x) => x === x);   // _extract_times: ≥ 2 stamps, none NaT

  let nBars = feats.bars;
  let entryPosFull = null;
  if (progress && !isNone(entryTime) && haveTimes) {
    const etMs = Number(entryTime) * 1000;
    let cnt = 0;
    while (cnt < N && full.t[cnt] <= etMs) cnt++;       // searchsorted(et, side="right")
    entryPosFull = Math.max(0, Math.min(cnt - 1, N - 1));
    nBars = Math.min(200, Math.max(nBars, N - entryPosFull + 15));
  }
  const start = Math.max(0, N - nBars);
  const raw = full.slice(start, N);
  const win = new Frame(Float64Array.from(raw.t), fillCol(raw.o), fillCol(raw.h), fillCol(raw.l), fillCol(raw.c), fillCol(raw.v));
  const n = win.length;

  const lastClose = win.c[n - 1];
  if (lastClose > 0 && entry > 0) {
    const ratio = Math.max(entry, lastClose) / Math.min(entry, lastClose);
    if (ratio > 5.0) {
      if (log && log.warning) {
        log.warning(`[CHART-PMULT-MISMATCH] ${symbol}: entry=${fmtG6(entry)} vs last_close=${fmtG6(lastClose)} `
          + `(ratio=${fmtFixed(ratio, 1)}×) — skip render, likely pmult bug`);
      }
      return null;
    }
  }
  if (entry <= 0) entry = lastClose;

  const barSec = haveTimes ? barSeconds(win.t) : null;
  const tf = tfLabel(barSec) || String(timeframe || '');

  const emas = [];
  if (feats.ema) {
    let periods = extra && truthy(extra.ema_periods) ? extra.ema_periods : null;
    if (!periods) periods = strategy === 'VOLUME' ? ['S10', 'S20', 'S50', 'E200'] : [20, 50, 200];
    for (const ma of calcEmas(full.c, periods)) {
      emas.push({ name: String(ma.period), label: ma.label, kind: ma.kind, period: ma.period, values: jarr(ma.values.subarray(start)) });
    }
  }

  const tps = [['TP1', tp1], ['TP2', tp2], ['TP3', tp3]];
  const isLong = direction !== 'SHORT';
  const hitsU = new Set((hitLevels || []).map((x) => pyUpper(String(x))));
  let entryIdx;
  if (progress) {
    if (entryPosFull !== null) {
      entryIdx = Math.max(0, entryPosFull - start);
    } else {
      const hp = tps.filter(([nm, p]) => p > 0 && hitsU.has(nm)).map(([, p]) => [p, isLong]);
      if (sl > 0 && hitsU.has('SL')) hp.push([sl, !isLong]);
      entryIdx = guessEntryIdx(win, entry, hp);
    }
  } else {
    entryIdx = n - 1;
  }

  const candles = new Array(n);
  for (let i = 0; i < n; i++) candles[i] = [win.t[i], jnum(win.o[i]), jnum(win.h[i]), jnum(win.l[i]), jnum(win.c[i]), jnum(win.v[i])];
  const zones = (k) => (extra && Array.isArray(extra[k]) ? extra[k] : []);
  return {
    timeframe: tf,
    meta: { symbol: normSymbol(symbol), strategy, direction, quality: String(quality || ''), score: Number(score) || 0 },
    candles,
    overlays: {
      entry: jnum(entry), sl: jnum(sl), tps: [jnum(tp1), jnum(tp2), jnum(tp3)],
      be: !isNone(bePrice) && bePrice > 0 ? jnum(Number(bePrice)) : null,
      ob: zones('ob'), fvg: zones('fvg'),
      pivots: feats.pivot && strategy === 'LEVELS' ? zones('pivots') : [],
      hvn: feats.vp ? zones('hvn') : [], lvn: feats.vp ? zones('lvn') : [],
      emas,
    },
    event: String(event || ''),
    hit_levels: (hitLevels || []).map(String),
    entry_index: entryIdx,
    last_close: jnum(lastClose),
  };
}

/** '%.6g' (the bot's log format). */
function fmtG6(x) {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return '0';
  const e = Math.floor(Math.log10(Math.abs(x)));
  if (e < -4 || e >= 6) {
    const s = x.toExponential(5).replace(/\.?0+e/, 'e');
    return s.replace(/e([+-])(\d)$/, 'e$10$2');
  }
  return String(Number(x.toPrecision(6)));
}

/**
 * h_signal_chart's renderer arguments for a signal view (miniapp_api lines 696–716):
 * status ≠ open → progress chart (event = STATUS, hit_levels TP1…TPn (+ SL), be_price = entry
 * after a TP, entry_time = created_at); open → the plain signal chart.
 */
function signalChartArgs(row, sig) {
  const order = ['tp1', 'tp2', 'tp3'];
  const nHit = order.includes(sig.status) ? order.indexOf(sig.status) + 1 : 0;
  const hit = order.slice(0, nHit).map((o) => o.toUpperCase());
  if (sig.status === 'sl') hit.push('SL');
  const base = {
    symbol: row.symbol, timeframe: sig.timeframe, direction: sig.direction, entry: sig.entry, sl: sig.sl,
    tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3, strategy: sig.strategy, tier: 'pro',
  };
  if (sig.status !== 'open') {
    return {
      ...base, event: pyUpper(sig.status), hit_levels: hit,
      be_price: hit.length && !hit.includes('SL') ? sig.entry : null,
      entry_time: sig.created_at ? sig.created_at : null,
    };
  }
  return base;
}

module.exports = { TIER_FEATURES, featuresForTier, normSymbol, barSeconds, tfLabel, calcEmas, guessEntryIdx, chartPayload, signalChartArgs, fmtG6 };
