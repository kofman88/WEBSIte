'use strict';
/**
 * frames.js — deterministic, hand-built candle scenarios for the VOLUME detector tests.
 *
 * Each builder returns a Frame of hourly bars (open_time from 2026-01-01 00:00 UTC) whose
 * shape targets ONE setup; the expected hits were produced by running the bot's own
 * volume_strategy.py on the very same bars (gen/gen_pins.py reads them from
 * `dumpScenarios()`), see detectors.test.js. Nothing random: every price is a
 * formula of the bar index, so the frames are reproducible in Python and JS alike.
 */

const { Frame } = require('../../strategies/common/frame');
const S = require('../../strategies/common/series');

const T0 = Date.UTC(2026, 0, 1);
const H = 3_600_000;

/** Plain candles around a close path: open = previous close, high/low = body ± wick. */
function candles(closes, { wick = 0.3, volume = () => 1000 } = {}) {
  const n = closes.length;
  const bars = [];
  for (let j = 0; j < n; j++) {
    const c = closes[j];
    const o = j === 0 ? c : closes[j - 1];
    bars.push([T0 + j * H, o, Math.max(o, c) + wick, Math.min(o, c) - wick, c, volume(j)]);
  }
  return bars;
}

function toFrame(bars) {
  return Frame.fromBars(bars);
}

/** Mirror a frame's prices around `pivot` (highs ↔ lows), volumes unchanged — turns LONG scenarios into SHORT ones. */
function mirror(frame, pivot) {
  const bars = frame.toBars().map(([t, o, h, l, c, v]) => [t, 2 * pivot - o, 2 * pivot - l, 2 * pivot - h, 2 * pivot - c, v]);
  return Frame.fromBars(bars);
}

/** First bar ≥ `from` where a − b turns positive after being ≤ 0 on the previous bar (−1 if none). */
function crossBar(a, b, from) {
  for (let j = Math.max(from, 1); j < a.length; j++) {
    if (a[j] - b[j] > 0 && a[j - 1] - b[j - 1] <= 0) return j;
  }
  return -1;
}

/** MA Cross (LONG): uptrend, 8-bar dip (SMA10 under SMA20), recovery; 2× volume on the cross bar. */
function crossLong() {
  const closes = [];
  for (let j = 0; j < 90; j++) {
    if (j < 50) closes.push(100 + 0.3 * j);
    else if (j < 58) closes.push(closes[j - 1] - 1.2);
    else closes.push(closes[j - 1] + 1.5);
  }
  const x = crossBar(S.sma(closes, 10), S.sma(closes, 20), 58);   // = 66
  return toFrame(candles(closes, { volume: (j) => (j === x ? 2000 : 1000) }));
}

/** MA Turn (LONG): gentle downtrend, V-reversal at bar 60 (+2/bar) on 1.8× volume. */
function turnLong() {
  const closes = [];
  for (let j = 0; j < 90; j++) {
    if (j < 60) closes.push(120 - 0.15 * j);
    else closes.push(closes[j - 1] + 2.0);
  }
  return toFrame(candles(closes, { volume: (j) => (j >= 60 ? 1800 : 1000) }));
}

/** Golden Cross (LONG): 250-bar downtrend then a 0.6/bar uptrend; 1.5× volume where EMA50 crosses EMA200. */
function goldenLong() {
  const closes = [];
  for (let j = 0; j < 400; j++) {
    if (j < 250) closes.push(200 - 0.2 * j);
    else closes.push(closes[j - 1] + 0.6);
  }
  const x = crossBar(S.ewmSpanAdjust(closes, 50), S.ewmSpanAdjust(closes, 200), 250);   // = 293
  return toFrame(candles(closes, { volume: (j) => (j === x ? 1500 : 1000 + 50 * ((j * 7) % 5)) }));
}

/**
 * EMA200 Bounce (LONG, hammer): 260-bar uptrend, 10-bar pullback (−2/bar, dry volume),
 * then a hammer whose low touches the EMA200 from above and closes 0.8 above it.
 * `body` = 0.5 makes the tail too short for a hammer (and the previous open is far above
 * the close, so no engulfing) → the [VOLUME-EMA-TOUCH] "touch" variant.
 */
function bounceLongHammer(body = 0.1) {
  const closes = [];
  for (let j = 0; j < 270; j++) {
    if (j < 260) closes.push(100 + 0.25 * j);
    else closes.push(closes[j - 1] - 2.0);
  }
  // signal bar: close = EMA200 + 0.8 (EMA includes the bar itself → fixed point iteration)
  let c = closes[269];
  let e = 0;
  for (let k = 0; k < 8; k++) {
    const arr = S.ewmSpanAdjust(closes.concat([c]), 200);
    e = arr[arr.length - 1];
    c = e + 0.8;
  }
  const bars = candles(closes, { volume: (j) => (j >= 260 ? 800 : 1000) });
  bars.push([T0 + 270 * H, c - body, c + 0.05, e - 0.1, c, 1500]);   // small body, long tail, tiny nose
  return toFrame(bars);
}

/**
 * EMA50 Bounce (SHORT, touch variant): downtrend (EMA50 under EMA200, falling), a 6-bar
 * rally back to the EMA50 from below, then a bearish bar whose high pokes 0.1 above the
 * EMA50 and closes 0.6 under it — no hammer, no engulfing → "touch".
 */
function bounceShortTouch() {
  const closes = [];
  for (let j = 0; j < 270; j++) {
    if (j < 264) closes.push(200 - 0.4 * j);
    else closes.push(closes[j - 1] + 1.0);
  }
  let c = closes[269];
  let e = 0;
  for (let k = 0; k < 8; k++) {
    const arr = S.ewmSpanAdjust(closes.concat([c]), 50);
    e = arr[arr.length - 1];
    c = e - 0.6;
  }
  const bars = candles(closes, { volume: (j) => (j >= 264 ? 800 : 1000) });
  bars.push([T0 + 270 * H, e + 0.05, e + 0.1, c - 0.05, c, 1500]);
  return toFrame(bars);
}

/**
 * Ribbon Pullback (LONG): 280-bar uptrend (+0.3/bar, ribbon fully ordered), 8-bar
 * pullback (−0.5/bar, dry volume) inside the ribbon, bullish bar back over the EMA5.
 */
function ribbonLong() {
  const closes = [];
  for (let j = 0; j < 288; j++) {
    if (j < 280) closes.push(100 + 0.3 * j);
    else closes.push(closes[j - 1] - 0.5);
  }
  const bars = candles(closes, { volume: (j) => (j >= 280 ? 700 : 1000) });
  const o = closes[287];
  const c = o + 1.2;
  bars.push([T0 + 288 * H, o, c + 0.1, o - 0.3, c, 1200]);
  return toFrame(bars);
}

/** Constant 60-bar frame — every MA finite and equal, nothing triggers (RSI = 50 by the NaN rule). */
function flat() {
  const closes = [];
  for (let j = 0; j < 60; j++) closes.push(100);
  return toFrame(candles(closes, { volume: (j) => 1000 + (j % 3) * 10 }));
}

/** Copy of a frame with one bar's volume replaced (gate-rejection variants). */
function withVolume(frame, i, volume) {
  const bars = frame.toBars();
  bars[i][5] = volume;
  return Frame.fromBars(bars);
}

/** Copy of a frame with every price shifted by `d` (same ATR / structure, smaller stop in % — [VOL-MIN-SL]). */
function shifted(frame, d) {
  return Frame.fromBars(frame.toBars().map(([t, o, h, l, c, v]) => [t, o + d, h + d, l + d, c + d, v]));
}

/** Copy of a frame with one bar's low raised by `d` (the wick no longer reaches the EMA). */
function withLow(frame, i, d) {
  const bars = frame.toBars();
  bars[i][3] += d;
  return Frame.fromBars(bars);
}

const SCENARIOS = Object.freeze({
  cross_long: crossLong,
  cross_short: () => mirror(crossLong(), 110),
  turn_long: turnLong,
  turn_short: () => mirror(turnLong(), 115),
  golden_long: goldenLong,
  golden_short: () => mirror(goldenLong(), 170),
  bounce_long_hammer: bounceLongHammer,
  bounce_short_hammer: () => mirror(bounceLongHammer(), 140),
  bounce_long_touch200: () => bounceLongHammer(0.5),
  bounce_short_touch: bounceShortTouch,
  bounce_long_touch: () => mirror(bounceShortTouch(), 120),
  ribbon_long: ribbonLong,
  ribbon_short: () => mirror(ribbonLong(), 150),
  flat,
  // gate-rejection variants: the volume gate of each setup, and a bounce whose wick misses the EMA
  cross_long_lowvol: () => withVolume(crossLong(), 66, 1200),
  turn_long_lowvol: () => withVolume(turnLong(), 62, 1200),
  golden_long_lowvol: () => withVolume(goldenLong(), 293, 900),
  bounce_long_hammer_lowvol: () => withVolume(bounceLongHammer(), 270, 700),
  ribbon_long_lowvol: () => withVolume(ribbonLong(), 288, 600),
  bounce_long_hammer_miss: () => withLow(bounceLongHammer(), 270, 1.0),
  // [VOL-MIN-VOLUME 2026-10] the ribbon / golden spikes above (≈ ×1.36) are under the ×1.5 floor now;
  // the same frames with a ≈ ×1.6–1.8 signal bar still fire
  ribbon_long_spike: () => withVolume(ribbonLong(), 288, 1600),
  ribbon_short_spike: () => mirror(withVolume(ribbonLong(), 288, 1600), 150),
  golden_long_spike: () => withVolume(goldenLong(), 293, 1800),
  golden_short_spike: () => mirror(withVolume(goldenLong(), 293, 1800), 170),
  bounce_long_hammer_x14: () => withVolume(bounceLongHammer(), 270, 1260),
  // [VOL-MIN-SL 2026-10] the same setups 300–400 higher: stop ≈ 0.3–0.4 % of the entry → the 15m floor widens it
  bounce_long_hammer_hi: () => shifted(bounceLongHammer(), 300),
  bounce_short_hammer_hi: () => shifted(mirror(bounceLongHammer(), 140), 300),
  ribbon_long_spike_hi: () => shifted(withVolume(ribbonLong(), 288, 1600), 400),
});

/** All scenarios as {name: bars[]} (the Python verifier reads this JSON). */
function dumpScenarios() {
  const out = {};
  for (const [name, build] of Object.entries(SCENARIOS)) out[name] = build().toBars();
  return out;
}

module.exports = { T0, H, candles, toFrame, mirror, crossBar, withVolume, withLow, shifted, SCENARIOS, dumpScenarios };
