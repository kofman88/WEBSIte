'use strict';
/**
 * gen_frames.js — deterministic candle frames + case tables for the LEVELS pattern /
 * approach / test-count / setup-search unit tests (M5).
 *
 *   node tests/levels/fixtures/gen_frames.js        → writes frames.json next to this file
 *
 * frames.json is then fed to gen_expected.py (the bot's own Python code in the pinned
 * venv) which writes expected.json; patterns.test.js / setups.test.js assert the JS port
 * against both. Bars are [open_time_ms, open, high, low, close, volume]; the last bar is
 * the last CLOSED bar (the bot's [CLOSED-BAR] convention). Prices ≈ 100 so the default
 * zone_pct 0.7 % ≈ 0.7 and max_dist_pct 1.5 % ≈ 1.5.
 */
const fs = require('fs');
const path = require('path');

const H = 3_600_000;
const T0 = Date.UTC(2025, 11, 23, 12, 0, 0); // 12:00 UTC → "🌍 Европа + США пересечение"

/** Tiny LCG so the file is reproducible without dependencies. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;

/** A bar from o/c and wick sizes (keeps OHLC consistent). */
function bar(t, o, c, uw, lw, v) {
  const hi = Math.max(o, c) + uw;
  const lo = Math.min(o, c) - lw;
  return [t, r4(o), r4(hi), r4(lo), r4(c), r4(v)];
}

/** n calm bars around `base` (tiny bodies, small wicks), deterministic. */
function calm(n, base = 100, seed = 1, t0 = T0, vol = 10) {
  const rnd = rng(seed);
  const out = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p + (rnd() - 0.5) * 0.06;
    out.push(bar(t0 + i * H, o, c, 0.02 + rnd() * 0.03, 0.02 + rnd() * 0.03, vol * (0.9 + rnd() * 0.2)));
    p = c;
  }
  return out;
}

/** Random-walk frame with varied bodies/wicks/volumes. */
function randomFrame(n, seed, base = 100, t0 = T0) {
  const rnd = rng(seed);
  const out = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p * (1 + (rnd() - 0.5) * 0.02);
    const uw = Math.abs(c - o) * rnd() * 2 + rnd() * 0.15;
    const lw = Math.abs(c - o) * rnd() * 2 + rnd() * 0.15;
    const v = 5 + rnd() * 20 * (rnd() < 0.15 ? 3 : 1);
    out.push(bar(t0 + i * H, o, c, uw, lw, v));
    p = c;
  }
  return out;
}

/** Replace the last k bars of `bars` with `tail` (keeps timestamps). */
function withTail(bars, tail) {
  const out = bars.slice(0, bars.length - tail.length);
  const t0 = bars[out.length][0];
  tail.forEach((b, i) => out.push([t0 + i * H, ...b.slice(1)]));
  return out;
}

const frames = {};
const add = (name, bars) => { frames[name] = bars; return name; };

// ───────────────────────────────── candle patterns (spec §8) ─────────────────────────────────
// pp, p, c as [o, c, uw, lw, v] built on a 5-bar calm prefix
const B = (o, c, uw, lw, v = 10) => bar(0, o, c, uw, lw, v);
const pat = (name, pp, p, c) => add(name, withTail(calm(8, 100, 11), [pp, p, c]));
const N = B(100, 100.05, 0.05, 0.05);          // neutral small bullish bar
const Nb = B(100.05, 100, 0.05, 0.05);         // neutral small bearish bar
pat('pat_bull_pin', N, N, B(100, 100.2, 0.05, 0.5));
pat('pat_bear_pin', N, N, B(100.2, 100, 0.5, 0.05));
pat('pat_bull_engulf', N, B(100.3, 100.0, 0.05, 0.05), B(99.95, 100.5, 0.1, 0.05));
pat('pat_bear_engulf', N, B(100.0, 100.3, 0.05, 0.05), B(100.35, 99.8, 0.05, 0.1));
pat('pat_dragonfly', N, N, B(100, 100.005, 0.005, 0.395));
pat('pat_gravestone', N, N, B(100.005, 100, 0.395, 0.01));
pat('pat_neutral_doji', N, N, B(100, 100.005, 0.195, 0.195));
pat('pat_hammer', N, N, B(100, 100.1, 0.08, 0.6));
pat('pat_inv_hammer', N, Nb, B(100.1, 100, 0.6, 0.08));
pat('pat_inside_bull', N, B(99.5, 100.5, 0.3, 0.3), B(99.9, 100.2, 0.15, 0.15));
pat('pat_inside_bear', N, B(99.5, 100.5, 0.3, 0.3), B(100.2, 99.9, 0.15, 0.15));
pat('pat_inside_flat', N, B(99.5, 100.5, 0.3, 0.3), B(100, 100, 0.3, 0.3));   // zero body, neutral doji, inside → nothing
pat('pat_morning_star', B(101, 100, 0.1, 0.1), B(99.9, 99.95, 0.35, 0.3), B(100, 100.8, 0.1, 0.05));
pat('pat_evening_star', B(100, 101, 0.1, 0.1), B(101.1, 101.05, 0.35, 0.3), B(101, 100.2, 0.05, 0.1));
pat('pat_zero_range', N, N, [0, 100, 100, 100, 100, 10]);
pat('pat_weak_bull', N, B(100.1, 100.2, 0.1, 0.1), B(100, 100.3, 0.2, 0.28));
pat('pat_weak_bear', Nb, B(100.2, 100.1, 0.1, 0.1), B(100.3, 100, 0.28, 0.2));
pat('pat_zero_body_bull_wick', N, N, B(100, 100, 0.1, 0.5));              // body 0 → doji path → dragonfly
add('pat_short3', calm(3, 100, 5));
add('pat_short4', calm(4, 100, 5));
const patternFrames = Object.keys(frames);
for (let k = 0; k < 60; k++) patternFrames.push(add(`pat_rand_${k}`, randomFrame(8, 1000 + k)));

// ─────────────────────────── institutional patterns (spec §9.5) ──────────────────────────────
const inst = (name, p, c) => add(name, withTail(calm(8, 100, 21), [N, p, c]));
const instCases = [];
const ic = (frame, level, direction, volRatio, zoneBuf) => instCases.push({ frame, level, direction, vol_ratio: volRatio, zone_buf: zoneBuf });
ic(inst('inst_sweep', N, B(99.9, 100.3, 0.05, 0.6)), 100, 'LONG', 2.5, 0.7);              // low 99.3 < 99.65, close > 100, vol > 2
ic(inst('inst_ob', B(100.9, 100.1, 0.05, 0.05), B(100.1, 100.4, 0.05, 0.05)), 100, 'LONG', 2.5, 0.7);  // p bearish body 80 %, vol > 2, c bullish
ic(inst('inst_fakeout_pin', N, B(100.05, 100.15, 0.05, 0.4)), 100, 'LONG', 1.0, 0.7);     // low 99.65 < 99.79, lw ≥ 1.5 body, uw < body
ic(inst('inst_engulf', B(100.3, 100.0, 0.05, 0.05), B(99.95, 100.5, 0.1, 0.05)), 100, 'LONG', 1.0, 0.7);
ic(inst('inst_pinbar', N, B(100.0, 100.1, 0.05, 0.2)), 100, 'LONG', 1.0, 0.7);             // low 99.8 ≥ 99.79 → not fakeout
ic(inst('inst_sfp', N, B(100.6, 100.9, 0.1, 1.4)), 100, 'LONG', 1.3, 0.7);                // low 99.2 < 99.3, lw 1.4 < 1.5×0.3? no: body .3 → lw ≥ .45 → pinbar... keep as a case either way
ic(inst('inst_sfp2', N, B(100.6, 100.9, 0.4, 1.4)), 100, 'LONG', 1.3, 0.7);               // uw .4 ≥ body .3 → not pinbar → SFP
ic(inst('inst_breakout_retest', N, B(100.4, 100.6, 0.1, 0.1)), 100, 'LONG', 1.6, 0.7);
ic(inst('inst_bounce_plain', N, B(100.4, 100.6, 0.1, 0.1)), 100, 'LONG', 1.0, 0.7);
ic(inst('inst_sweep_short', N, B(100.1, 99.7, 0.6, 0.05)), 100, 'SHORT', 2.5, 0.7);
ic(inst('inst_ob_short', B(99.1, 99.9, 0.05, 0.05), B(99.9, 99.6, 0.05, 0.05)), 100, 'SHORT', 2.5, 0.7);
ic(inst('inst_fakeout_pin_short', N, B(99.95, 99.85, 0.4, 0.05)), 100, 'SHORT', 1.0, 0.7);
ic(inst('inst_engulf_short', B(99.7, 100.0, 0.05, 0.05), B(100.05, 99.5, 0.05, 0.1)), 100, 'SHORT', 1.0, 0.7);
ic(inst('inst_pinbar_short', N, B(100.0, 99.9, 0.2, 0.05)), 100, 'SHORT', 1.0, 0.7);
ic(inst('inst_sfp_short', N, B(99.4, 99.1, 1.4, 0.4)), 100, 'SHORT', 1.3, 0.7);
add('inst_short4', calm(4, 100, 5));
ic('inst_short4', 100, 'LONG', 2.5, 0.7);
for (let k = 0; k < 40; k++) {
  const name = add(`inst_rand_${k}`, randomFrame(8, 2000 + k));
  const close = frames[name][7][4];
  for (const off of [0.99, 1.0, 1.01]) {
    for (const dir of ['LONG', 'SHORT']) {
      for (const vr of [1.0, 1.3, 1.6, 2.5]) ic(name, r4(close * off), dir, vr, r4(close * off * 0.007));
    }
  }
}

// ────────────────────────────── approach quality (spec §9.6) ─────────────────────────────────
const approachCases = [];
const ac = (frame, level, zoneBuf, volLen, instPattern) => approachCases.push({ frame, level, zone_buf: zoneBuf, vol_len: volLen, inst: instPattern });
// 12 calm bars at 100 then overrides; level 100, zone_buf 0.7, vol_len 5
const calm12 = () => calm(12, 100, 31);
ac(add('appr_impulse', withTail(calm12(), [B(100, 100.9, 0.05, 0.05, 50)])), 100, 0.7, 5, '');
ac('appr_impulse', 100, 0.7, 5, 'LIQUIDITY_SWEEP');
ac('appr_impulse', 100, 0.7, 5, 'INSTITUTIONAL_ORDERBLOCK');
ac('appr_impulse', 100, 0.7, 5, 'SFP');
ac(add('appr_vertical_up', withTail(calm12(), [B(97, 98.2, 0.05, 0.05), B(98.2, 99.4, 0.05, 0.05), B(99.4, 100.6, 0.05, 0.05), B(100.6, 100.5, 0.1, 0.1)])), 100, 0.7, 5, '');
ac(add('appr_vertical_down', withTail(calm12(), [B(103, 101.8, 0.05, 0.05), B(101.8, 100.6, 0.05, 0.05), B(100.6, 99.4, 0.05, 0.05), B(99.4, 99.5, 0.1, 0.1)])), 100, 0.7, 5, '');
ac(add('appr_vertical_broken', withTail(calm12(), [B(97, 98.2, 0.05, 0.05), B(98.2, 97, 0.05, 0.05), B(97, 98.2, 0.05, 0.05), B(98.2, 98.3, 0.1, 0.1)])), 100, 0.7, 5, '');
// over-tested: 4 of the last 9 bars (excluding bar −1) touch the ±0.7 band around 100 — far bars at 103
const far = () => calm(12, 103, 32);
ac(add('appr_over_tested', withTail(far(), [B(100, 100.1, 0.1, 0.1), B(103, 103.1, 0.1, 0.1), B(100.2, 100, 0.1, 0.1), B(103, 103.1, 0.1, 0.1), B(100.1, 100.3, 0.1, 0.1), B(100.3, 100.1, 0.1, 0.1), B(103, 103.1, 0.1, 0.1)])), 100, 0.7, 5, '');
// consolidation: 3 touches among bars −7..−2 (and < 4 in −10..−2)
ac(add('appr_consolidation', withTail(far(), [B(100, 100.1, 0.1, 0.1), B(103, 103.1, 0.1, 0.1), B(100.2, 100, 0.1, 0.1), B(103, 103.1, 0.1, 0.1), B(100.1, 100.3, 0.1, 0.1), B(103, 103.1, 0.1, 0.1), B(103, 103.1, 0.1, 0.1)])), 100, 0.7, 5, '');
// decaying bodies + declining volume, no touch
ac(add('appr_decay_decline', withTail(far(), [B(103, 103.5, 0.1, 0.1, 30), B(103.5, 103.1, 0.1, 0.1, 25), B(103.1, 103.4, 0.1, 0.1, 20), B(103.4, 103.2, 0.1, 0.1, 15), B(103.2, 103.3, 0.1, 0.1, 40)])), 100, 0.7, 5, '');
ac(add('appr_neutral', withTail(far(), [B(103, 103.1, 0.1, 0.1, 10), B(103.1, 103.4, 0.1, 0.1, 12), B(103.4, 103.2, 0.1, 0.1, 15), B(103.2, 103.5, 0.1, 0.1, 11), B(103.5, 103.3, 0.1, 0.1, 10)])), 100, 0.7, 5, '');
add('appr_short5', calm(5, 100, 5));
ac('appr_short5', 100, 0.7, 5, '');
ac(add('appr_zero_vol', withTail(calm12(), [B(100, 100.1, 0.1, 0.1, 0), B(100.1, 100.2, 0.1, 0.1, 0), B(100.2, 100.1, 0.1, 0.1, 0), B(100.1, 100.2, 0.1, 0.1, 5)])), 100, 0.7, 5, '');
for (let k = 0; k < 40; k++) {
  const name = add(`appr_rand_${k}`, randomFrame(12, 3000 + k));
  const close = frames[name][11][4];
  for (const off of [1.0, 1.004]) for (const ip of ['', 'LIQUIDITY_SWEEP']) ac(name, r4(close * off), r4(close * 0.007), 5, ip);
  ac(name, r4(close), r4(close * 0.007), 20, '');   // vol_ma NaN → avg_vol 1.0
}

// ─────────────────────────────── test counting (spec §9.7) ────────────────────────────────────
const testsCases = [];
const tc = (frame, level, zonePct, lookback) => testsCases.push({ frame, level, zone_pct: zonePct, lookback });
tc(add('tests_in_out_in', withTail(calm(12, 103, 41), [B(100, 100.1, 0.1, 0.1), B(100.1, 100.2, 0.1, 0.1), B(103, 103.1, 0.1, 0.1), B(100.2, 100, 0.1, 0.1), B(103, 103.1, 0.1, 0.1)])), 100, 0.7, 30);
tc('tests_in_out_in', 100, 0.7, 2);
tc('tests_in_out_in', 100, 0.7, 3);
tc('tests_in_out_in', 100, 3.0, 30);   // wide band: everything in → 1 entry
for (let k = 0; k < 40; k++) {
  const name = add(`tests_rand_${k}`, randomFrame(40, 4000 + k));
  const close = frames[name][39][4];
  for (const off of [1.0, 1.01, 0.99]) for (const zp of [0.7, 1.0]) tc(name, r4(close * off), zp, 30);
  tc(name, r4(close), 0.7, 10);
}

// ───────────────────────────── setup search (spec §9.1–9.8) ──────────────────────────────────
// Scenarios run through indicator._do_analyze with _precomputed_zones (Python) /
// analyzePart1 with precomputedZones (JS). cfg overrides are TradeCfg fields.
const scenarios = [];
const zone = (price, hits = 2, cls = 2) => ({ price, hits, class: cls });
const sc = (name, bars, zones, cfg = {}, extra = {}) => {
  add(`setup_${name}`, bars);
  scenarios.push({ name, frame: `setup_${name}`, zones, cfg: { use_rsi: false, max_level_tests: 99, ...cfg }, relax: false, ...extra });
};
const base30 = (seed = 51, t0 = T0, basePrice = 100) => calm(30, basePrice, seed, t0);
const bullPin = (o = 100, c = 100.2) => B(o, c, 0.05, 0.5, 10);
const bearPin = (o = 100.2, c = 100) => B(o, c, 0.5, 0.05, 10);
const plain = (o, c, v = 10) => B(o, c, 0.1, 0.1, v);

// Prefixes sit ~1.6 % away from the level so the approach rule "4+ touches of the last 9 bars"
// does not fire on every scenario (the search order is then observable past the approach gate).
const above = (seed, t0 = T0) => calm(30, 101.6, seed, t0);   // for LONG at support 100 (price comes down)
const below = (seed, t0 = T0) => calm(30, 98.4, seed, t0);    // for SHORT at resistance 100 (price comes up)
// A. LONG from support — SFP beats Fakeout (both true), and block A beats a SHORT in block C
sc('A_sfp_beats_fakeout_and_short', withTail(above(), [plain(101.0, 100.9, 30), [0, 100.9, 101.6, 99.0, 100.2, 30]]),
  { sup: [zone(100, 3, 1)], res: [zone(100.8, 2, 2)] });
// A. Fakeout (low < lvl − 0.5·zb but not < lvl − zb)
sc('A_fakeout', withTail(above(52), [plain(101.0, 100.9), [0, 100.9, 101.0, 99.5, 100.2, 12]]), { sup: [zone(100, 2, 2)], res: [] });
// A. SFP condition without volume (vol_ratio ≤ 1.2) falls to Fakeout
sc('A_sfp_no_volume', withTail(above(53), [plain(101.0, 100.9), [0, 100.9, 101.0, 99.0, 100.2, 9]]), { sup: [zone(100, 2, 2)], res: [] });
// A. Bounce with a bull pin (low 99.68 ≥ lvl − zb → not a fakeout), close ≥ lvl − zone_buf
sc('A_bounce_pin', withTail(above(54), [plain(101.0, 100.6), B(100.0, 100.2, 0.05, 0.32)]), { sup: [zone(100, 2, 2)], res: [] });
// A. bull pattern but close below the zone → no bounce (and nothing else) → 'signal'
sc('A_bounce_close_below_zone', withTail(above(55), [plain(99.5, 99.4), B(99.1, 99.2, 0.02, 0.2)]), { sup: [zone(100, 2, 2)], res: [] });
// A. two supports in proximity, both fake out → highest first
sc('A_highest_first', withTail(above(56), [plain(101.0, 100.6), [0, 100.6, 100.7, 98.4, 100.3, 15]]), { sup: [zone(99.0, 2, 3), zone(100, 2, 2)], res: [] });
// A. the highest support is out of the proximity window → the lower one is used
sc('A_proximity_skip', withTail(above(57), [plain(101.0, 100.6), [0, 100.6, 100.7, 98.4, 100.3, 15]]), { sup: [zone(99.0, 2, 3), zone(102.5, 2, 2)], res: [] });
// B. retest of a broken resistance: closes −7..−2 above lvl (out of the band), low near lvl, bull pin
sc('B_retest', withTail(calm(30, 101.2, 58), [plain(101.2, 101.1), B(100.6, 100.8, 0.05, 0.5)]), { sup: [], res: [zone(100, 2, 2)] });
// B. honest breakout: close[-2] < lvl, close > lvl + zb, vol_ratio > 1.5, no bull pattern
sc('B_breakout', withTail(below(59), [plain(99.6, 99.7), plain(99.7, 100.9, 40)]), { sup: [], res: [zone(100, 2, 2)] });
// B. retest is tried before breakout (both true: bull pin with low near lvl, close[-2] < lvl, close > lvl + zb, volume)
sc('B_retest_before_breakout', withTail(calm(30, 101.2, 60), [plain(100.4, 99.8), B(100.75, 100.9, 0.05, 0.65, 40)]), { sup: [], res: [zone(100, 2, 2)] });
// C. SHORT SFP vs Fakeout, with no support matching
sc('C_sfp', withTail(below(61), [plain(99.0, 99.1, 30), [0, 99.1, 101.1, 99.0, 99.8, 30]]), { sup: [], res: [zone(100, 2, 2)] });
sc('C_fakeout', withTail(below(62), [plain(99.0, 99.1), [0, 99.1, 100.5, 99.0, 99.8, 12]]), { sup: [], res: [zone(100, 2, 2)] });
sc('C_bounce_pin', withTail(below(63), [plain(99.0, 99.4), B(100.0, 99.8, 0.32, 0.05)]), { sup: [], res: [zone(100, 2, 2)] });
sc('C_bounce_close_above_zone', withTail(below(64), [plain(100.5, 100.6), B(100.9, 100.8, 0.2, 0.02)]), { sup: [], res: [zone(100, 2, 2)] });
sc('C_highest_first', withTail(below(65), [plain(99.0, 99.4), [0, 99.4, 101.6, 99.3, 99.7, 15]]), { sup: [], res: [zone(100, 2, 2), zone(101.0, 2, 3)] });
// D. retest of broken support: closes −7..−2 below lvl (out of the band), high near lvl, bear pin
sc('D_retest', withTail(calm(30, 98.8, 66), [plain(98.8, 98.9), B(99.4, 99.2, 0.5, 0.05)]), { sup: [zone(100, 2, 2)], res: [] });
// D. breakdown: close[-2] > lvl, close < lvl − zb, vol_ratio > 1.5
sc('D_breakdown', withTail(above(67), [plain(100.4, 100.3), plain(100.3, 99.1, 40)]), { sup: [zone(100, 2, 2)], res: [] });
// gates
sc('gate_no_zones', base30(68), { sup: [], res: [] });
sc('gate_nearest_too_far', base30(69), { sup: [zone(97.5, 2, 2)], res: [zone(102.5, 2, 2)] });
sc('gate_signal_level_too_far', withTail(above(70), [plain(100.0, 100.1), [0, 100.1, 100.3, 97.4, 100.0, 15]]), { sup: [zone(98.2, 2, 2)], res: [zone(100.5, 2, 3)] });
sc('gate_volume', withTail(above(71), [plain(101.0, 100.9), [0, 100.9, 101.0, 99.5, 100.2, 2]]), { sup: [zone(100, 2, 2)], res: [] });
sc('gate_volume_off', withTail(above(71), [plain(101.0, 100.9), [0, 100.9, 101.0, 99.5, 100.2, 2]]), { sup: [zone(100, 2, 2)], res: [] }, { use_volume: false });
sc('gate_no_setup', withTail(above(72), [plain(100.0, 100.1), plain(100.1, 100.2), B(100.2, 100.2, 0.1, 0.1)]), { sup: [zone(100, 2, 2)], res: [] });
// impulse: breakout bar with vol_ratio ≈ 1.9 (BREAKOUT_RETEST, not exempt) and body/range > 0.7
sc('gate_approach_impulse', withTail(below(73), [plain(99.6, 99.7), plain(99.8, 100.9, 19)]), { sup: [], res: [zone(100, 2, 2)] });
// test count ≥ MAX_LEVEL_TESTS: 3 entries early in the 30-bar window, bars −10..−2 away, bar −1 = 4th entry
const away = (s) => calm(1, 103, s)[0];
sc('gate_over_tested', [plain(100, 100.1), away(1), plain(100.2, 100), away(2), plain(100.1, 100.3), ...calm(24, 103, 74), [0, 100.3, 100.4, 99.5, 100.2, 12]].map((b, i) => [T0 + i * H, ...b.slice(1)]), { sup: [zone(100, 2, 2)], res: [] }, { max_level_tests: 4 });
sc('gate_approach_over_tested', withTail(base30(75), [plain(100, 100.1), plain(100.1, 100.2), plain(100.2, 100.1), plain(100.1, 100.0), plain(100.0, 100.1), B(100.0, 100.2, 0.05, 0.32)]), { sup: [zone(100, 2, 2)], res: [] });
// RSI gates: a steep 16-bar ramp ending just outside the band (≤ 3 touches), then a fakeout bar
// at the level in the ramp's direction (RSI stays extreme)
const rising = []; for (let i = 0; i < 16; i++) rising.push(plain(96 + i * 0.25, 96.17 + i * 0.25));
sc('gate_rsi_long', withTail(calm(30, 96, 76), [...rising, [0, 99.9, 100.3, 99.5, 100.2, 12]]), { sup: [zone(100, 2, 2)], res: [] }, { use_rsi: true });
const falling = []; for (let i = 0; i < 16; i++) falling.push(plain(104 - i * 0.25, 103.83 - i * 0.25));
sc('gate_rsi_short', withTail(calm(30, 104, 77), [...falling, [0, 100.1, 100.5, 99.7, 99.8, 12]]), { sup: [], res: [zone(100, 2, 2)] }, { use_rsi: true });
// relax mode: weak bull pattern + wider bounce/proximity windows
sc('relax_weak_bounce', withTail(base30(78), [plain(100.4, 100.3), B(100, 100.3, 0.2, 0.28)]), { sup: [zone(98.5, 2, 2)], res: [] }, { max_dist_pct: 5 }, { relax: true });
sc('norelax_same_bars', withTail(base30(78), [plain(100.4, 100.3), B(100, 100.3, 0.2, 0.28)]), { sup: [zone(98.5, 2, 2)], res: [] }, { max_dist_pct: 5 });
// sessions / local trend coverage: Asia hour, dead zone, and a bearish local trend (counter-trend LONG)
// the last bar is t0 + 29 h: 22:00 → 03:00 UTC (Asia), 17:00 → 22:00 UTC (dead zone)
sc('session_asia', withTail(above(79, Date.UTC(2025, 11, 22, 22, 0, 0)), [plain(101.0, 100.6), B(100.0, 100.2, 0.05, 0.32)]), { sup: [zone(100, 2, 2)], res: [] });
sc('session_dead', withTail(above(80, Date.UTC(2025, 11, 22, 17, 0, 0)), [plain(101.0, 100.6), B(100.0, 100.2, 0.05, 0.32)]), { sup: [zone(100, 2, 2)], res: [] });
const down = []; for (let i = 0; i < 28; i++) down.push(plain(112 - i * 0.4, 111.86 - i * 0.4));
sc('counter_trend_long', withTail(base30(81, T0, 112), [...down, B(100.0, 100.2, 0.05, 0.32)]), { sup: [zone(100, 2, 2)], res: [] });
// random scenarios: random walk + zones placed around the last close
for (let k = 0; k < 60; k++) {
  const rnd = rng(9000 + k);
  const bars = randomFrame(30, 5000 + k, 100, T0 + Math.floor(rnd() * 24) * H);
  const close = bars[29][4];
  const zs = { sup: [], res: [] };
  const nz = 1 + Math.floor(rnd() * 3);
  for (let j = 0; j < nz; j++) {
    const price = r4(close * (1 + (rnd() - 0.5) * 0.05));
    (rnd() < 0.5 ? zs.sup : zs.res).push(zone(price, 2 + Math.floor(rnd() * 3), 1 + Math.floor(rnd() * 3)));
  }
  zs.sup.sort((a, b) => a.price - b.price); zs.res.sort((a, b) => a.price - b.price);
  sc(`rand_${k}`, bars, zs, { use_rsi: rnd() < 0.5, max_level_tests: rnd() < 0.5 ? 4 : 99, use_volume: rnd() < 0.8, zone_pct: rnd() < 0.5 ? 0.7 : 1.2, max_dist_pct: rnd() < 0.5 ? 1.5 : 3.0 }, { relax: rnd() < 0.2 });
}

const out = { frames, pattern_frames: patternFrames, institutional_cases: instCases, approach_cases: approachCases, tests_cases: testsCases, setup_scenarios: scenarios };
fs.writeFileSync(path.join(__dirname, 'frames.json'), JSON.stringify(out));
console.log(`frames=${Object.keys(frames).length} patterns=${patternFrames.length} inst=${instCases.length} approach=${approachCases.length} tests=${testsCases.length} setups=${scenarios.length}`);
