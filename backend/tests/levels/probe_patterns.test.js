/**
 * probe_patterns.test.js — lattice fuzz of the LEVELS candle-pattern layer against the bot
 * (tests/golden/levels_probe_patterns.json.gz, `make_levels_probe.py --suite patterns`).
 *
 * 4000 short frames (4–16 bars) whose prices sit on base + k·tick (ticks 1 … 1e-11, so the
 * 1e-10 guards are straddled), with frequent equalities (open = close, high = low, open = the
 * previous close) and exact threshold hits; NaN volumes now and then. For every frame the bot
 * ran _detect_pattern, and with 4 lattice levels / zone buffers / threshold vol_ratios each
 * _detect_institutional_pattern, _assess_approach_quality (vol_ma = rolling(vol_len).mean(),
 * recomputed here with series.rollingMean), _check_fakeout and _count_recent_tests. A Python
 * exception (`{"error": "IndexError"}`) must be a JS throw.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import load from '../golden/load.js';
import { Frame } from '../../strategies/common/frame.js';
import S from '../../strategies/common/series.js';
import P from '../../strategies/levels/patterns.js';
import { GOLDEN } from './probeReplay.js';
import prodPython from '../common/prodPython.js';

const { PROD_PYTHON } = prodPython;

const STEM = 'levels_probe_patterns';
const FILE = path.join(GOLDEN, `${STEM}.json.gz`);
const PRESENT = fs.existsSync(FILE);

function loadFuzz() {
  const raw = zlib.gunzipSync(fs.readFileSync(FILE));
  const summary = JSON.parse(fs.readFileSync(path.join(GOLDEN, `${STEM}_summary.json`), 'utf8'));
  expect(load.sha256(raw)).toBe(summary.sha256[`${STEM}.json`]);
  return { doc: JSON.parse(raw.toString('utf8')), summary };
}

const H = 3_600_000;
const T0 = 1_767_225_600_000;
const frameOf = (bars) => Frame.fromBars(bars.map((b, i) => [T0 + i * H, b[0], b[1], b[2], b[3], b[4] === null ? NaN : b[4]]));

/** Run fn → the record shape of make_levels_probe._pat_call. */
function call(fn) {
  try {
    return fn();
  } catch (e) {
    return { error: e && e.name === 'IndexError' ? 'IndexError' : `JS:${e && e.message}` };
  }
}

describe('LEVELS pattern layer: lattice fuzz vs the bot (make_levels_probe.py --suite patterns)', () => {
  if (!PRESENT) {
    it.todo(`${STEM}.json.gz not generated yet`);
    return;
  }
  const { doc, summary } = loadFuzz();
  const frames = doc.frames.map((r) => ({ ...r, df: frameOf(r.bars) }));

  it('fuzz file is intact', () => {
    expect(doc.python).toMatch(PROD_PYTHON);
    expect(frames.length).toBe(summary.frames);
    expect(frames.length).toBeGreaterThanOrEqual(4000);
  });

  const check = (name, rows) => {
    const bad = rows.filter((r) => JSON.stringify(r.got) !== JSON.stringify(r.want));
    if (bad.length) {
      throw new Error(`${name}: ${bad.length}/${rows.length} mismatches\n${bad.slice(0, 15).map((r) => `  ${r.label}: got ${JSON.stringify(r.got)}, bot ${JSON.stringify(r.want)}`).join('\n')}`);
    }
    expect(rows.length).toBeGreaterThan(0);
  };

  it('_detect_pattern', () => {
    check('_detect_pattern', frames.map((r, i) => {
      const got = call(() => { const p = P.detectPattern(r.df); return [p.bull, p.bear]; });
      return { label: `#${i} ${JSON.stringify(r.bars.slice(-3))}`, got, want: r.pattern };
    }));
  });

  it('_detect_institutional_pattern', () => {
    const rows = [];
    frames.forEach((r, i) => r.inst.forEach(([level, dir, vr, zb, want]) => {
      const got = call(() => { const x = P.detectInstitutionalPattern(r.df, level, dir, vr, zb); return [x.name, x.bonus]; });
      rows.push({ label: `#${i} ${dir} level=${level} vr=${vr} zb=${zb}`, got, want });
    }));
    check('_detect_institutional_pattern', rows);
  });

  it('_assess_approach_quality (incl. the IndexError of 6-bar frames)', () => {
    const rows = [];
    frames.forEach((r, i) => {
      const volMa = S.rollingMean(r.df.v, r.vol_len, r.vol_len);
      r.approach.forEach(([level, zb, inst, want]) => {
        const got = call(() => { const x = P.assessApproachQuality(r.df, level, zb, volMa, inst); return [x.ok, x.reason]; });
        rows.push({ label: `#${i} n=${r.bars.length} level=${level} zb=${zb} inst=${inst}`, got, want });
      });
    });
    check('_assess_approach_quality', rows);
    expect(rows.some((x) => x.want && x.want.error === 'IndexError')).toBe(true);
  });

  it('_check_fakeout', () => {
    const rows = [];
    frames.forEach((r, i) => r.fakeout.forEach(([level, dir, zb, want]) => {
      rows.push({ label: `#${i} ${dir} level=${level} zb=${zb}`, got: call(() => P.checkFakeout(r.df, level, dir, zb)), want });
    }));
    check('_check_fakeout', rows);
  });

  it('_count_recent_tests', () => {
    const rows = [];
    frames.forEach((r, i) => r.tests.forEach(([level, zp, lb, want]) => {
      rows.push({ label: `#${i} level=${level} zone_pct=${zp} lookback=${lb}`, got: call(() => P.countRecentTests(r.df, level, zp, lb)), want });
    }));
    check('_count_recent_tests', rows);
  });
});
