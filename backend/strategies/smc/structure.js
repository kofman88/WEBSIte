'use strict';
/**
 * structure.js — one-to-one port of `smc/structure.py`: swing highs/lows,
 * trend (HH/HL vs LH/LL), BOS and CHoCH as *states* of the last CLOSED bar
 * (spec strategy-smc.md §4.1).
 *
 * Frames are {t, o, h, l, c, v} Float64Array structs (strategies/common/frame.js);
 * every function reads `[-1]` as the last closed bar. Output dicts keep the
 * Python key names because they are the bot's analysis dict (digested by the
 * golden fixtures and read by the signal builder).
 */

function nBars(frame) {
  return frame.length !== undefined ? frame.length : frame.c.length;
}

/** The empty BOS / CHoCH result of the Python code. */
function emptyBreak() {
  return { detected: false, price: 0.0, direction: '', bar_ago: 0, wick_sweep: false };
}

/**
 * numpy `window.max()` / `.min()` over [lo, hi): a NaN anywhere makes the result
 * NaN (so `highs[i] == NaN` is False and the bar is not a swing).
 */
function windowMax(a, lo, hi) {
  let m = -Infinity;
  for (let j = lo; j < hi; j++) { const v = a[j]; if (v !== v) return Number.NaN; if (v > m) m = v; }
  return m;
}
function windowMin(a, lo, hi) {
  let m = Infinity;
  for (let j = lo; j < hi; j++) { const v = a[j]; if (v !== v) return Number.NaN; if (v < m) m = v; }
  return m;
}

/** find_swing_highs: high[i] == max(high[i−n : i+n+1]) for i in [n, N−n). Ties count (plateaus → several swings). */
function findSwingHighs(frame, lookback = 10) {
  const highs = frame.h;
  const n = highs.length;
  const result = [];
  for (let i = lookback; i < n - lookback; i++) {
    const m = windowMax(highs, Math.max(0, i - lookback), Math.min(n, i + lookback + 1));
    if (highs[i] === m) {
      result.push({ idx: i, price: highs[i], bar: n - 1 - i, ts: frame.t ? frame.t[i] : null });
    }
  }
  return result;
}

/** find_swing_lows: low[i] == min(low[i−n : i+n+1]). */
function findSwingLows(frame, lookback = 10) {
  const lows = frame.l;
  const n = lows.length;
  const result = [];
  for (let i = lookback; i < n - lookback; i++) {
    const m = windowMin(lows, Math.max(0, i - lookback), Math.min(n, i + lookback + 1));
    if (lows[i] === m) {
      result.push({ idx: i, price: lows[i], bar: n - 1 - i, ts: frame.t ? frame.t[i] : null });
    }
  }
  return result;
}

/** Python `sorted(swings, key=lambda x: x["idx"])` (stable). */
function sortedByIdx(swings) {
  return swings.slice().sort((a, b) => a.idx - b.idx);
}

/** detect_trend: HH+HL → BULLISH, LH+LL → BEARISH, else RANGING (needs ≥ 2 of each). */
function detectTrend(swingHighs, swingLows) {
  if (swingHighs.length < 2 || swingLows.length < 2) return 'RANGING';
  const sh = sortedByIdx(swingHighs).slice(-2);
  const sl = sortedByIdx(swingLows).slice(-2);
  const hh = sh[1].price > sh[0].price;
  const hl = sl[1].price > sl[0].price;
  const lh = sh[1].price < sh[0].price;
  const ll = sl[1].price < sl[0].price;
  if (hh && hl) return 'BULLISH';
  if (lh && ll) return 'BEARISH';
  return 'RANGING';
}

/**
 * detect_bos(df, swing_highs, swing_lows, confirm_close=True) — evaluated on the
 * last closed bar against the most recent swing of each side. UP is tested first
 * and returns on body-close or wick-only; DOWN only when the high stayed ≤ level.
 */
function detectBos(frame, swingHighs, swingLows, confirmClose = true) {
  const n = nBars(frame);
  const close = frame.c, highs = frame.h, lows = frame.l;
  const result = emptyBreak();
  if (!swingHighs.length || !swingLows.length) return result;

  const lastSh = sortedByIdx(swingHighs);
  const lastSl = sortedByIdx(swingLows);

  // ── BOS UP ──
  if (lastSh.length) {
    const prevSh = lastSh[lastSh.length - 1];
    const level = prevSh.price;
    const bodyAbove = close[n - 1] > level;
    const wickAbove = highs[n - 1] > level;
    if (bodyAbove) {
      return { detected: true, price: level, direction: 'BULLISH', bar_ago: prevSh.bar, wick_sweep: false };
    } else if (wickAbove && confirmClose) {
      // QUIRK(spec §4.1): the Python debug f-string reads highs[-2]/close[-2] eagerly; with
      // < 2 bars it would raise IndexError (unreachable: structure needs ≥ 30 bars).
      return { detected: false, price: level, direction: 'BULLISH', bar_ago: prevSh.bar, wick_sweep: true };
    } else if (!confirmClose && wickAbove) {
      return { detected: true, price: level, direction: 'BULLISH', bar_ago: prevSh.bar, wick_sweep: false };
    }
  }

  // ── BOS DOWN ──
  if (lastSl.length) {
    const prevSl = lastSl[lastSl.length - 1];
    const level = prevSl.price;
    const bodyBelow = close[n - 1] < level;
    const wickBelow = lows[n - 1] < level;
    if (bodyBelow) {
      return { detected: true, price: level, direction: 'BEARISH', bar_ago: prevSl.bar, wick_sweep: false };
    } else if (wickBelow && confirmClose) {
      Object.assign(result, { detected: false, price: level, direction: 'BEARISH', bar_ago: prevSl.bar, wick_sweep: true });
    } else if (!confirmClose && wickBelow) {
      Object.assign(result, { detected: true, price: level, direction: 'BEARISH', bar_ago: prevSl.bar, wick_sweep: false });
    }
  }
  return result;
}

/**
 * detect_choch(df, swing_highs, swing_lows): in a BEARISH trend a body close above
 * the last LH → CHoCH UP; in a BULLISH trend a body close below the last HL →
 * CHoCH DOWN; wick-only → wick_sweep. RANGING → empty.
 * QUIRK(spec §4.1): CHoCH UP and BOS BULLISH test the same level, so in a BEARISH
 * trend one close above the last swing high sets both `bos.detected` and `choch.detected`.
 */
function detectChoch(frame, swingHighs, swingLows) {
  const trend = detectTrend(swingHighs, swingLows);
  const n = nBars(frame);
  const close = frame.c, highs = frame.h, lows = frame.l;
  const result = emptyBreak();

  if (trend === 'BEARISH' && swingHighs.length) {
    const sorted = sortedByIdx(swingHighs);
    const prevSh = sorted[sorted.length - 1];
    const level = prevSh.price;
    const bodyAbove = close[n - 1] > level;
    const wickAbove = highs[n - 1] > level;
    if (bodyAbove) {
      Object.assign(result, { detected: true, price: level, direction: 'UP', bar_ago: prevSh.bar, wick_sweep: false });
    } else if (wickAbove) {
      Object.assign(result, { detected: false, price: level, direction: 'UP', bar_ago: prevSh.bar, wick_sweep: true });
    }
  } else if (trend === 'BULLISH' && swingLows.length) {
    const sorted = sortedByIdx(swingLows);
    const prevSl = sorted[sorted.length - 1];
    const level = prevSl.price;
    const bodyBelow = close[n - 1] < level;
    const wickBelow = lows[n - 1] < level;
    if (bodyBelow) {
      Object.assign(result, { detected: true, price: level, direction: 'DOWN', bar_ago: prevSl.bar, wick_sweep: false });
    } else if (wickBelow) {
      Object.assign(result, { detected: false, price: level, direction: 'DOWN', bar_ago: prevSl.bar, wick_sweep: true });
    }
  }
  return result;
}

/**
 * get_market_structure(df, lookback=10, bos_confirm=True, choch_enabled=True).
 * Fewer than lookback·3 bars → the RANGING/empty result.
 */
function getMarketStructure(frame, lookback = 10, bosConfirm = true, chochEnabled = true) {
  if (nBars(frame) < lookback * 3) {
    return {
      trend: 'RANGING', swing_highs: [], swing_lows: [],
      bos: emptyBreak(), choch: emptyBreak(),
      last_swing_high: null, last_swing_low: null,
      bos_wick_sweep: false, choch_wick_sweep: false,
    };
  }
  const sh = findSwingHighs(frame, lookback);
  const sl = findSwingLows(frame, lookback);
  const trend = detectTrend(sh, sl);
  const bos = detectBos(frame, sh, sl, bosConfirm);
  const choch = chochEnabled ? detectChoch(frame, sh, sl) : emptyBreak();

  const lastSh = sh.length ? sortedByIdx(sh)[sh.length - 1] : null;
  const lastSl = sl.length ? sortedByIdx(sl)[sl.length - 1] : null;

  return {
    trend,
    swing_highs: sh,
    swing_lows: sl,
    bos,
    choch,
    last_swing_high: lastSh,
    last_swing_low: lastSl,
    bos_wick_sweep: Boolean(bos.wick_sweep),
    choch_wick_sweep: Boolean(choch.wick_sweep),
  };
}

module.exports = {
  emptyBreak, findSwingHighs, findSwingLows, sortedByIdx, detectTrend, detectBos, detectChoch, getMarketStructure,
};
