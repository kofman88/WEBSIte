/**
 * volume_scanner.py pure parts — dedup_ttl_s, the HTF pre-pass of _analyze_with_htf,
 * apply_squeeze_bonus / [CTX-GATE], and the pre-pass superset claim re-checked against the
 * golden fixtures: for every swept bar the pre-pass (no HTF, min_quality − 1) and the
 * direct call must agree on "signal or not" exactly where the generator recorded
 * `scanner_prepass_mismatch_bars` (11 bars for default, 11 for conservative).
 */
import { describe, it, expect } from 'vitest';
import V from '../../strategies/volume/index.js';
import F from './frames.js';
import P from './pins.js';
import load from '../golden/load.js';

const { pins } = P;

describe('dedupTtlS / prepassConfig / passesCtxGate', () => {
  it('[VOLUME-TTL] 4 bars of the TF, at least an hour; unknown → 4 h', () => {
    for (const [tf, want] of Object.entries(pins.dedup_ttl)) expect(V.dedupTtlS(tf)).toBe(want);
    expect(pins.dedup_ttl).toEqual({ '15m': 3600, '1h': 14400, '4h': 57600, '1d': 345600, '1H': 14400, '': 14400, '7x': 14400 });
    expect(V.dedupTtlS(null)).toBe(14400);
  });
  it('prepassConfig: use_htf=false, min_quality = max(1, min_quality − 1), nothing else (no _fix)', () => {
    const cfg = V.VolumeConfig.fromParams({ min_quality: 4 });
    const pre = V.prepassConfig(cfg);
    expect(pre.use_htf).toBe(false);
    expect(pre.min_quality).toBe(3);
    expect(V.prepassConfig(V.VolumeConfig.fromParams({ min_quality: 1 })).min_quality).toBe(1);
    const a = cfg.toDict(), b = pre.toDict();
    delete a.use_htf; delete a.min_quality; delete b.use_htf; delete b.min_quality;
    expect(b).toEqual(a);
    expect(cfg.use_htf).toBe(true);
  });
  it('passesCtxGate', () => {
    const cfg = V.VolumeConfig.fromParams({ min_quality: 3 });
    expect(V.passesCtxGate(3, cfg)).toBe(true);
    expect(V.passesCtxGate(2, cfg)).toBe(false);
  });
});

describe('analyzeWithHtf (the live rule)', () => {
  const frame = F.SCENARIOS.bounce_long_hammer();
  const up = F.toFrame(Array.from({ length: 60 }, (_, j) => [F.T0 + j * 4 * F.H, 100 + j, 101 + j, 99 + j, 100 + j, 1]));
  it('use_htf=false → the plain call, the loader is never asked', () => {
    let calls = 0;
    const cfg = V.VolumeConfig.fromParams({ use_htf: false });
    const sig = V.analyzeWithHtf('T', frame, cfg, '1h', () => { calls++; return up; });
    expect(calls).toBe(0);
    expect(sig.quality).toBe(4);
  });
  it('pre-pass null → null without loading HTF; pre-pass hit → HTF loaded and the final call returns the HTF-aware signal', () => {
    let calls = 0;
    const cfg = new V.VolumeConfig();
    expect(V.analyzeWithHtf('T', F.SCENARIOS.flat(), cfg, '1h', () => { calls++; return up; })).toBeNull();
    expect(V.analyzeWithHtf('T', frame.prefix(230), cfg, '1h', () => { calls++; return up; })).toBeNull();
    expect(calls).toBe(0);
    const sig = V.analyzeWithHtf('T', frame, cfg, '1h', () => { calls++; return up; });
    expect(calls).toBe(1);
    expect(sig.quality).toBe(5);
    expect(sig.htf_state).toBe(2);
    expect(V.analyzeWithHtf('T', frame, cfg, '1h', () => null).htf_state).toBe(0);    // HTF unavailable → plain
    expect(V.analyzeWithHtf('T', frame, cfg, '7x', () => { throw new Error('no'); }).htf_state).toBe(0); // unknown tf → plain call
  });
});

describe('applySqueezeBonus / scannerPostSteps', () => {
  const mk = (setup, quality = 3) => new V.VolumeSignal({ setup, quality, squeeze: 0, symbol: 'S' });
  const frames = load.loadFrames('SYNRG01-USDT-SWAP');
  // find a swept bar with a squeeze and one without (compute_squeeze_score on the 1h prefix)
  let squeezed = null, calm = null;
  for (let i = 200; i < 400 && (!squeezed || !calm); i++) {
    const df = load.barInputs(frames, i).df;
    const sc = V.computeSqueezeScore(df);
    if (sc >= 1 && !squeezed) squeezed = { df, sc };
    if (sc === 0 && !calm) calm = { df };
  }
  it('fixture has both squeezed and calm bars', () => {
    expect(squeezed).not.toBeNull();
    expect(calm).not.toBeNull();
  });
  it('cross/turn/golden out of a squeeze: +1 quality (cap 5), sig.squeeze = score; idempotent', () => {
    const sig = mk('cross', 4);
    expect(V.applySqueezeBonus(sig, squeezed.df)).toBe(squeezed.sc);
    expect(sig.quality).toBe(5);
    expect(sig.squeeze).toBe(squeezed.sc);
    expect(V.applySqueezeBonus(sig, squeezed.df)).toBe(squeezed.sc);   // already applied → returns sig.squeeze, no second +1
    expect(sig.quality).toBe(5);
    const s5 = mk('golden', 5);
    V.applySqueezeBonus(s5, squeezed.df);
    expect(s5.quality).toBe(5);
  });
  it('bounce / ribbon never get the bonus; calm market → 0 and untouched; null → 0', () => {
    for (const setup of ['bounce', 'ribbon']) {
      const sig = mk(setup, 3);
      expect(V.applySqueezeBonus(sig, squeezed.df)).toBe(0);
      expect(sig.quality).toBe(3);
      expect(sig.squeeze).toBe(0);
    }
    const sig = mk('turn', 3);
    expect(V.applySqueezeBonus(sig, calm.df)).toBe(0);
    expect(sig.quality).toBe(3);
    expect(V.applySqueezeBonus(null, calm.df)).toBe(0);
  });
  it('scannerPostSteps is the side-effect-free record of the same steps', () => {
    const cfg = V.VolumeConfig.fromParams({ min_quality: 4 });
    const sig = mk('cross', 3);
    expect(V.scannerPostSteps(sig, squeezed.df, cfg)).toEqual({ squeeze_score: squeezed.sc, quality_after_squeeze: 4, passes_ctx_gate: true });
    expect(sig.quality).toBe(3);
    expect(V.scannerPostSteps(mk('bounce', 3), squeezed.df, cfg)).toEqual({ squeeze_score: 0, quality_after_squeeze: 3, passes_ctx_gate: false });
    expect(V.scannerPostSteps(mk('cross', 3), calm.df, cfg)).toEqual({ squeeze_score: 0, quality_after_squeeze: 3, passes_ctx_gate: false });
  });
});

describe('pre-pass superset claim vs the golden fixtures (scanner_prepass_mismatch_bars)', () => {
  const expected = load.loadExpected('volume');
  const totals = {};
  for (const variantName of ['default', 'conservative', 'active']) {
    const variant = expected.variants[variantName];
    const cfg = V.VolumeConfig.fromParams(variant.params);
    const pre = V.prepassConfig(cfg);
    describe(variantName, () => {
      for (const symbol of load.listSymbols()) {
        it(symbol, () => {
          const fx = expected.fixtures[symbol][variantName];
          const frames = load.loadFrames(symbol);
          const mismatch = [];
          if (cfg.use_htf && V.htfFor('1h')) {
            for (const i of load.sweepIndices(frames['1h'].length, 1)) {
              const b = load.barInputs(frames, i);
              const sig = V.analyzeVolume(symbol, b.df, cfg, '1h', b.dfHtf4h);
              const preSig = V.analyzeVolume(symbol, b.df, pre, '1h');
              if ((preSig === null) !== (sig === null)) mismatch.push(i);
            }
          }
          expect(mismatch).toEqual(fx.scanner_prepass_mismatch_bars);
          totals[variantName] = (totals[variantName] || 0) + mismatch.length;
        });
      }
    });
  }
  it('totals match summary.json (default 11, conservative 11, active 0)', () => {
    expect(totals).toEqual({ default: 11, conservative: 11, active: 0 });
  });
});
