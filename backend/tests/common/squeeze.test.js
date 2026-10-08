/**
 * squeeze.js — squeeze_detector.compute_squeeze_score / is_squeeze_active /
 * get_squeeze_diagnostics against the bot's layer dump (dumps/squeeze.json: 3 fixtures ×
 * 200 bars, r10-identical internals) and the short-frame / threshold rules.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import Q from '../../strategies/common/squeeze.js';
import F from '../../strategies/common/pyfmt.js';
import load from '../golden/load.js';

const { r10 } = F;
const same = (a, b) => (b === null ? !(a === a) || a === null : r10(a) === b);

describe('computeSqueezeScore vs dumps/squeeze.json', () => {
  const file = path.join(load.GOLDEN_DIR, 'dumps', 'squeeze.json');
  const sq = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  (sq ? it : it.skip)('score and internals are identical on every dumped bar', () => {
    const failures = [];
    let scored = 0;
    for (const [symbol, bars] of Object.entries(sq.fixtures)) {
      const frames = load.loadFrames(symbol);
      for (const [iStr, want] of Object.entries(bars)) {
        const df = load.barInputs(frames, Number(iStr)).df;
        const got = Q.computeSqueezeScore(df);
        if (got !== want.score) failures.push(`${symbol} bar ${iStr} score ${got} != ${want.score}`);
        if (got) scored++;
        const r = Q.internals(df);
        const pairs = [['current', 'bbw_last'], ['thrStrong', 'thr_strong'], ['thrSome', 'thr_some'], ['atr14', 'atr14'], ['atr50', 'atr50'], ['atrRatio', 'atr_ratio']];
        for (const [k, wk] of pairs) if (!same(r[k], want[wk])) failures.push(`${symbol} bar ${iStr} ${wk}: ${r[k]} != ${want[wk]}`);
        const d = Q.squeezeDiagnostics(df);
        if (d.score !== want.score || !d.enough_data) failures.push(`${symbol} bar ${iStr} diagnostics score ${d.score}`);
        if (Q.isSqueezeActive(df) !== (r.current <= r.thrSome && r.atrRatio <= 0.85)) failures.push(`${symbol} bar ${iStr} isSqueezeActive`);
      }
    }
    if (failures.length) throw new Error(`${failures.length} mismatches:\n${failures.slice(0, 10).join('\n')}`);
    expect(scored).toBeGreaterThan(0);
  });
});

describe('rules', () => {
  const frames = load.loadFrames('BTC-USDT-SWAP');
  const df = frames['1h'];
  it('fewer than max(lookback + 21, 51) bars → 0 / false / not enough data', () => {
    expect(Q.computeSqueezeScore(df.prefix(69))).toBe(0);
    expect(Q.isSqueezeActive(df.prefix(69))).toBe(false);
    expect(Q.squeezeDiagnostics(df.prefix(69))).toEqual({ bbwidth_current: 0.0, bbwidth_pctile: 100.0, atr_ratio: 1.0, score: 0, label: 'no', enough_data: false });
    expect(Q.computeSqueezeScore(null)).toBe(0);
    expect(Q.computeSqueezeScore(df.prefix(30), { lookback: 5 })).toBe(0);   // max(26, 51) = 51
  });
  it('thresholds: strong = both ≤ 15 % / 0.7, some = either ≤ 30 % / 0.85; overridable', () => {
    const r = Q.internals(df);
    const score = Q.computeSqueezeScore(df);
    const bbStrong = r.current <= r.thrStrong, bbSome = r.current <= r.thrSome;
    const atrStrong = r.atrRatio <= 0.7, atrSome = r.atrRatio <= 0.85;
    expect(score).toBe(bbStrong && atrStrong ? 2 : (bbSome || atrSome ? 1 : 0));
    expect(Q.computeSqueezeScore(df, { pctileStrong: 100, pctileSome: 100, atrRatioStrong: 1e9, atrRatioSome: 1e9 })).toBe(2);
    expect(Q.computeSqueezeScore(df, { pctileStrong: 0, pctileSome: 0, atrRatioStrong: 0, atrRatioSome: 0 })).toBe(0);
    const d = Q.squeezeDiagnostics(df);
    expect(d.enough_data).toBe(true);
    expect(d.bbwidth_pctile).toBeGreaterThanOrEqual(2);    // the current width counts itself (≤)
    expect(['no', 'some', 'strong'][d.score]).toBe(d.label);
    expect(Q.formatSqueezeLog('BTC', '1h', d)).toMatch(/^\[SQUEEZE-DETECTED\] sym=BTC tf=1h score=\d label=\w+ bbw_pctile=\d+\.\d% atr_ratio=\d+\.\d\d$/);
  });
  it('bbWidth: NaN for the first 19 rows and where the SMA is 0', () => {
    const w = Q.bbWidth(df.c);
    expect(Number.isNaN(w[18])).toBe(true);
    expect(Number.isFinite(w[19])).toBe(true);
    const z = Q.bbWidth(Float64Array.from({ length: 25 }, () => 0));
    expect(Number.isNaN(z[24])).toBe(true);
  });
});
