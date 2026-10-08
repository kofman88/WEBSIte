/**
 * marketRegime.test.js — common/marketRegime.detectRegime against market_regime.detect_regime
 * (bot's own code, tests/levels/fixtures/part2_expected.json → regime):
 *   • 953 cases on real golden frames (1h prefixes 54…400 of 7 symbols, the 1d frames, a crafted
 *     high-vol frame) × every TF key incl. unknown / "" / None, explicit slope_thresh /
 *     ema_period / atr_period / high_vol_pct overrides;
 *   • the per-TF threshold table and the lowercase "1d" fallback quirk (48 real bars where
 *     tf="1d" and tf="1D" disagree);
 *   • regime_allows_direction and sl_v2.levels_regime_multiplier tables.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import load from '../golden/load.js';
import { Frame } from '../../strategies/common/frame.js';
import R from '../../strategies/common/marketRegime.js';

const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'levels', 'fixtures', 'part2_expected.json');
const EXP = JSON.parse(fs.readFileSync(FIX, 'utf8'));
const RG = EXP.regime;

function frameOf(c) {
  if (c.bars) return Frame.fromBars(c.bars);
  const f = load.loadFrame(c.symbol, c.tf_src);
  return c.tf_src === '1h' ? f.slice(0, c.n) : f;
}

function optsOf(c) {
  const o = { tf: c.tf };
  if (c.slope_thresh !== undefined) o.slopeThresh = c.slope_thresh;
  if (c.ema_period !== undefined) o.emaPeriod = c.ema_period;
  if (c.atr_period !== undefined) o.atrPeriod = c.atr_period;
  if (c.high_vol_pct !== undefined) o.highVolPct = c.high_vol_pct;
  return o;
}

describe('detectRegime vs market_regime.detect_regime', () => {
  it('every recorded case (real frames × TF keys × overrides) returns the same regime', () => {
    const failures = [];
    const seen = {};
    for (const c of RG.cases) {
      const got = R.detectRegime(frameOf(c), optsOf(c));
      seen[got] = (seen[got] || 0) + 1;
      if (got !== c.regime) failures.push(`${c.symbol} ${c.tf_src} n=${c.n} tf=${JSON.stringify(c.tf)} ${JSON.stringify(optsOf(c))}: ${got} != ${c.regime}`);
    }
    if (failures.length) throw new Error(`${failures.length} mismatches of ${RG.cases.length}:\n${failures.slice(0, 15).join('\n')}`);
    expect(RG.cases.length).toBeGreaterThan(900);
    // all four regimes are exercised by the table
    for (const k of ['trending_up', 'trending_down', 'ranging', 'high_vol']) expect(seen[k]).toBeGreaterThan(0);
  });

  it('per-TF slope thresholds equal the bot table; "1d" (lowercase) falls back to the 0.001 baseline', () => {
    expect(R.SLOPE_THRESH_BY_TF).toEqual(RG.thresholds);
    expect(R.SLOPE_THRESH).toBe(RG.baseline);
    expect(R.slopeThreshForTf('1d')).toBe(0.001);
    expect(R.slopeThreshForTf('1D')).toBe(0.0005);
    expect(R.slopeThreshForTf('4h')).toBe(0.0007);
    expect(R.slopeThreshForTf('15m')).toBe(0.002);
    expect(R.slopeThreshForTf(null)).toBe(0.001);
    expect(R.slopeThreshForTf('')).toBe(0.001);
    expect(R.slopeThreshForTf('xx')).toBe(0.001);
    expect(R.slopeThreshForTf('toString')).toBe(0.001);   // dict.get, not prototype lookup
  });

  it('QUIRK: the lowercase "1d" key gives a different verdict than "1D" on real bars (48 recorded)', () => {
    expect(RG.quirk.length).toBeGreaterThan(0);
    for (const q of RG.quirk) {
      const df = load.loadFrame(q.symbol, q.tf_src).slice(0, q.n);
      expect(R.detectRegime(df, { tf: '1d' })).toBe(q.lower);
      expect(R.detectRegime(df, { tf: '1D' })).toBe(q.upper);
      expect(q.lower).not.toBe(q.upper);
    }
  });

  it('an explicit slope_thresh is never recalibrated by tf; fewer than 55 bars / null → "ranging"', () => {
    const df = load.loadFrame('SYNUP01-USDT-SWAP', '1h').slice(0, 300);
    expect(R.detectRegime(df, { tf: '15m', slopeThresh: 1e9 })).toBe('ranging');
    expect(R.detectRegime(df, { tf: '15m', slopeThresh: 0.001 })).toBe(R.detectRegime(df, { tf: '1h' }));
    expect(R.detectRegime(df.slice(0, 54), { tf: '1h' })).toBe('ranging');
    expect(R.detectRegime(null)).toBe('ranging');
    expect(R.detectRegime(df, { tf: '1h', highVolPct: 0 })).toBe('high_vol');
  });

  it('regimeAllowsDirection / levelsRegimeMultiplier tables', () => {
    expect(R.regimeAllowsDirection('trending_up', 'SHORT')).toBe(false);
    expect(R.regimeAllowsDirection('trending_up', 'LONG')).toBe(true);
    expect(R.regimeAllowsDirection('trending_down', 'LONG')).toBe(false);
    expect(R.regimeAllowsDirection('trending_down', 'SHORT')).toBe(true);
    expect(R.regimeAllowsDirection('ranging', 'SHORT')).toBe(true);
    expect(R.regimeAllowsDirection('high_vol', 'LONG')).toBe(true);
    expect(R.regimeAllowsDirection(null, 'LONG')).toBe(true);
    expect(R.levelsRegimeMultiplier(null)).toEqual([1.0, 'unknown']);
    expect(R.levelsRegimeMultiplier('')).toEqual([1.0, 'unknown']);
    expect(R.levelsRegimeMultiplier(' Trending_Up ')).toEqual([0.85, 'trending_up']);
    expect(R.levelsRegimeMultiplier('ranging')).toEqual([1.2, 'ranging']);
    expect(R.levelsRegimeMultiplier('high_vol')).toEqual([1.0, 'high_vol']);
    expect(R.levelsRegimeMultiplier('volatile')).toEqual([1.1, 'volatile']);
    expect(R.levelsRegimeMultiplier('constructor')).toEqual([1.0, 'constructor']);
  });
});
