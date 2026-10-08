'use strict';
/**
 * gen_frames.js — regenerates frames.json: small hand-built candle frames for
 * tests/smc/analysis.test.js. The same JSON is fed to the bot's Python code by
 * gen_expected.py so both sides see identical numbers.
 *
 *   node tests/smc/fixtures/gen_frames.js [out.json]
 */
const fs = require('fs');
const path = require('path');

const T0 = 1_700_000_000_000;
const H = 3_600_000;

/** Bars from anchor points: closes interpolated linearly, open = prev close, high = close+1, low = close-1. */
function zigzag(anchors, n, volume = 1000) {
  const closes = new Array(n);
  for (let k = 0; k < anchors.length - 1; k++) {
    const [i0, p0] = anchors[k];
    const [i1, p1] = anchors[k + 1];
    for (let i = i0; i <= i1; i++) closes[i] = p0 + (p1 - p0) * (i - i0) / (i1 - i0);
  }
  const bars = [];
  for (let i = 0; i < n; i++) {
    const c = closes[i];
    const o = i === 0 ? c : closes[i - 1];
    bars.push([T0 + i * H, o, c + 1, c - 1, c, volume + i]);
  }
  return bars;
}

function withLast(bars, o, h, l, c, v = 5000) {
  const out = bars.map((b) => b.slice());
  const i = out.length - 1;
  out[i] = [out[i][0], o, h, l, c, v];
  return out;
}

const N = 60;
// LH/LL structure: peaks 15 (110), 35 (105); troughs 25 (95), 45 (90); then rising
const bearish = zigzag([[0, 100], [15, 110], [25, 95], [35, 105], [45, 90], [59, 104]], N);
// HH/HL structure: troughs 15 (95), 35 (100); peaks 25 (110), 45 (120)
const bullish = zigzag([[0, 100], [15, 95], [25, 110], [35, 100], [45, 120], [59, 110]], N);
// equal lows (90 / 90.05) and equal highs (100 / 100), ranging
const ranging = zigzag([[0, 95], [15, 90], [25, 100], [35, 90.05], [45, 100], [59, 95]], N);

const frames = {
  // structure (HTF, lookback 10)
  htf_bearish_choch_up: withLast(bearish, 104, 109, 103.5, 108),      // close 108 > last swing high 106 → BOS BULLISH + CHoCH UP
  htf_bearish_wick: withLast(bearish, 104, 107, 103.5, 105),          // high 107 > 106, close 105 ≤ 106 → wick sweeps
  htf_bearish_none: withLast(bearish, 104, 105.5, 103.5, 104.5),      // nothing broken
  htf_bullish_bos: withLast(bullish, 110, 126, 109, 125),             // close 125 > last swing high 121 → BOS BULLISH, no CHoCH
  htf_bullish_choch_down: withLast(bullish, 110, 111, 94, 95),        // close 95 < last swing low 99 → BOS BEARISH + CHoCH DOWN
  htf_bullish_wick_down: withLast(bullish, 110, 111, 97, 100),        // low 97 < 99, close 100 ≥ 99 → wick sweeps DOWN
  htf_short: bearish.slice(0, 20),                                    // < 30 bars → RANGING/empty
  // liquidity (HTF): equal lows mean 89.025, equal highs 101
  htf_sweep_up: withLast(ranging, 90, 91, 88.5, 90.5),                // lower wick 1.5 / range 2.5 = 0.6, closes back above
  htf_sweep_up_noclose: withLast(ranging, 90, 91, 87.0, 88.9),        // wick 1.9 / 4 = 0.475 but close 88.9 < level
  htf_sweep_down: withLast(ranging, 100.5, 102.5, 100.2, 100.4),      // upper wick 2.0 / 2.3 ≈ 0.87, closes back below 101
  // order blocks (MTF)
  mtf_ob_plain: [
    [T0 + 0 * H, 100, 101, 99, 100.5, 1000],
    [T0 + 1 * H, 100.5, 101.5, 99.5, 101, 1000],
    [T0 + 2 * H, 101, 101.5, 99.8, 100.2, 1000],
    [T0 + 3 * H, 100.2, 102.5, 100.1, 102.3, 1000],
    [T0 + 4 * H, 102.3, 103.5, 102.0, 103.2, 1000],
    [T0 + 5 * H, 103.2, 104.0, 102.8, 103.8, 1000],
    [T0 + 6 * H, 103.8, 104.2, 103.0, 103.5, 1000],
    [T0 + 7 * H, 103.5, 103.9, 102.9, 103.1, 1000],
    [T0 + 8 * H, 103.1, 103.6, 102.5, 102.8, 1000],
    [T0 + 9 * H, 102.8, 103.2, 101.0, 101.4, 1000],
  ],
  mtf_ob_breaker: [
    [T0 + 0 * H, 100, 101, 99, 100.5, 1000],
    [T0 + 1 * H, 100.5, 101.5, 99.5, 101, 1000],
    [T0 + 2 * H, 101, 101.5, 99.8, 100.2, 1000],
    [T0 + 3 * H, 100.2, 102.5, 100.1, 102.3, 1000],
    [T0 + 4 * H, 102.3, 103.5, 102.0, 103.2, 1000],
    [T0 + 5 * H, 103.2, 104.0, 102.8, 103.8, 1000],
    [T0 + 6 * H, 103.8, 104.2, 103.0, 103.5, 1000],
    [T0 + 7 * H, 103.5, 103.9, 102.9, 103.1, 1000],
    [T0 + 8 * H, 103.1, 103.6, 99.0, 99.5, 1000],
    [T0 + 9 * H, 99.5, 103.9, 99.3, 103.7, 1000],
  ],
  // FVG (LTF)
  ltf_fvg: [
    [T0 + 0 * H, 100, 101, 99, 100.5, 1000],
    [T0 + 1 * H, 100.5, 102, 100.2, 101.8, 1000],
    [T0 + 2 * H, 101.8, 103.5, 102.0, 103.3, 1000],
    [T0 + 3 * H, 103.3, 104, 101.5, 103.8, 1000],
    [T0 + 4 * H, 103.8, 105.5, 104.0, 105.2, 1000],
    [T0 + 5 * H, 105.2, 105.8, 103.2, 103.4, 1000],
    [T0 + 6 * H, 103.4, 103.9, 102.8, 103.0, 1000],
    [T0 + 7 * H, 103.0, 103.1, 101.8, 102.0, 1000],
    [T0 + 8 * H, 102.0, 102.4, 101.2, 101.5, 1000],
  ],
  // volume / ATR (MTF, 30 bars, distinctive volumes)
  mtf_volume: zigzag([[0, 50], [10, 55], [20, 48], [29, 52]], 30).map((b, i) => [b[0], b[1], b[2], b[3], b[4], 100 + 7 * i + (i % 3) * 13.25]),
};

const target = process.argv[2] || path.join(__dirname, 'frames.json');
fs.writeFileSync(target, JSON.stringify(frames, null, 1) + '\n');
console.log('wrote', target, Object.keys(frames).map((k) => `${k}:${frames[k].length}`).join(' '));
