/**
 * squeeze.test.js — strategies/common/squeeze.js vs the bot's squeeze_detector.py.
 *
 * Python-verified: tests/golden/dumps/squeeze.json holds compute_squeeze_score's
 * internals (bbw_last, thr_strong, thr_some, atr14, atr50, atr_ratio, bbw_recent,
 * score) for 3 fixtures × 200 bars, produced by `make_golden.py --dump-squeeze` with
 * the pinned venv. Every value must be r10-identical.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Frame } from '../../strategies/common/frame.js';
import { r10 } from '../../strategies/common/pyfmt.js';
import { computeSqueezeScore, isSqueezeActive, squeezeDiagnostics, bbWidth, SQUEEZE_DEFAULTS } from '../../strategies/common/squeeze.js';
import load from '../golden/load.js';

const DUMP = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'golden', 'dumps', 'squeeze.json');
const dump = fs.existsSync(DUMP) ? JSON.parse(fs.readFileSync(DUMP, 'utf8')) : null;

const same = (a, b) => (b === null ? a === null || a === undefined || !Number.isFinite(a) : r10(a) === b);

describe('squeeze detector', () => {
  (dump ? it : it.skip)('internals and score are r10-identical to squeeze_detector.py on the layer dump', () => {
    const failures = [];
    let bars = 0;
    for (const [symbol, perBar] of Object.entries(dump.fixtures)) {
      const frames = load.loadFrames(symbol);
      for (const [iStr, want] of Object.entries(perBar)) {
        const b = load.barInputs(frames, Number(iStr));
        const got = squeezeDiagnostics(b.df);
        bars++;
        if (got.n !== want.n || got.score !== want.score) failures.push(`${symbol} bar ${iStr}: n/score ${got.n}/${got.score} != ${want.n}/${want.score}`);
        if (computeSqueezeScore(b.df) !== want.score) failures.push(`${symbol} bar ${iStr}: computeSqueezeScore != ${want.score}`);
        for (const k of ['bbw_last', 'thr_strong', 'thr_some', 'atr14', 'atr50', 'atr_ratio']) {
          if (!same(got[k], want[k])) failures.push(`${symbol} bar ${iStr} ${k}: ${got[k]} (r10 ${r10(got[k])}) != ${want[k]}`);
        }
        if (want.bbw_recent) {
          for (let j = 0; j < want.bbw_recent.length; j++) {
            if (!same(got.bbw_recent[j], want.bbw_recent[j])) { failures.push(`${symbol} bar ${iStr} bbw_recent[${j}]`); break; }
          }
        }
        if (want.atr_ratio !== null) {
          const active = want.bbw_last <= want.thr_some && want.atr_ratio <= SQUEEZE_DEFAULTS.atrRatioSome;
          if (isSqueezeActive(b.df) !== active) failures.push(`${symbol} bar ${iStr}: isSqueezeActive != ${active}`);
        }
      }
    }
    expect(bars).toBeGreaterThan(0);
    expect(failures, failures.slice(0, 10).join('\n')).toEqual([]);
  });

  it('null / short frames → 0, false, not enough data', () => {
    expect(computeSqueezeScore(null)).toBe(0);
    expect(isSqueezeActive(null)).toBe(false);
    const short = Frame.fromBars(Array.from({ length: 70 }, (_, i) => [i, 100, 101, 99, 100 + (i % 5) * 0.1, 1]));
    expect(computeSqueezeScore(short)).toBe(0);            // < max(50 + 21, 51) bars
    expect(squeezeDiagnostics(short).enough_data).toBe(false);
    expect(squeezeDiagnostics(null).label).toBe('no');
  });

  it('score 2 needs BOTH strong conditions, 1 needs either "some" condition; thresholds are configurable', () => {
    // 71 bars: wide swings first, then a flat tail → compressed BB width and ATR at the end
    const bars = [];
    for (let i = 0; i < 71; i++) {
      const wild = i < 40;
      const c = wild ? 100 + ((i % 2) ? 5 : -5) : 100 + (i % 2) * 0.01;
      bars.push([i, c, c + (wild ? 3 : 0.02), c - (wild ? 3 : 0.02), c, 1]);
    }
    const f = Frame.fromBars(bars);
    const d = squeezeDiagnostics(f);
    expect(d.enough_data).toBe(true);
    expect(d.score).toBe(2);
    expect(d.label).toBe('strong');
    expect(d.atr_ratio).toBeLessThan(0.7);
    expect(computeSqueezeScore(f, { atrRatioStrong: 0.0, atrRatioSome: 0.0 })).toBe(1);   // only the BB "some" condition left
    expect(computeSqueezeScore(f, { atrRatioStrong: 10.0, bbPctileStrong: 100.0 })).toBe(2);   // both strong conditions trivially true
    expect(isSqueezeActive(f)).toBe(true);
    expect(bbWidth(f.c).length).toBe(71);
    expect(Number.isNaN(bbWidth(f.c)[18])).toBe(true);     // rolling(20) warm-up
  });
});
