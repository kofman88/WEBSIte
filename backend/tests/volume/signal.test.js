/**
 * signal_at / analyze_volume — stop placement helpers (nearest_structure, effective_atr),
 * quality, LONG-wins-ties, the full VolumeSignal on the scenario frames (bit-identical to
 * the bot, pins.json) and the guards (min_bars, no setups, non-finite inputs).
 */
import { describe, it, expect } from 'vitest';
import V from '../../strategies/volume/index.js';
import F from './frames.js';
import P from './pins.js';
import load from '../golden/load.js';

const { pins, assertSame } = P;
const N = Number.NaN;

describe('nearestStructure / effectiveAtr (pinned by the bot)', () => {
  const S = pins.structure;
  it('SHORT: nearest pivot high within the lookback (spec example → 103.0)', () => {
    const h = Float64Array.from([100, 110, 105, 101, 100, 99, 103, 101, 100, 99.5]);
    const l = h.map((x) => x - 1.0);
    expect(V.nearestStructure(h, l, 9, -1, 10)).toBe(S.short_pinned);
    expect(S.short_pinned).toBe(103.0);
  });
  it('LONG: nearest pivot low (→ 90.0); i = 1 falls back to the window; lookback 2', () => {
    const l = Float64Array.from([100, 85, 95, 97, 96, 98, 90, 94, 95, 96]);
    const h = l.map((x) => x + 1.0);
    expect(V.nearestStructure(h, l, 9, 1, 10)).toBe(S.long_pinned);
    expect(V.nearestStructure(h, l, 1, 1, 10)).toBe(S.long_i1);
    expect(V.nearestStructure(h, l, 9, 1, 2)).toBe(S.long_lb2);
    expect([S.long_pinned, S.long_i1, S.long_lb2]).toEqual([90.0, 85.0, 94.0]);
  });
  it('SHORT monotonic highs, lookback 5 → the window extreme (120.0)', () => {
    const h = Float64Array.from([100, 101, 102, 103, 104, 105, 106, 107, 108, 120]);
    expect(V.nearestStructure(h, h.map((x) => x - 1), 9, -1, 5)).toBe(S.short_monotonic_lb5);
    expect(S.short_monotonic_lb5).toBe(120.0);
  });
  it('effectiveAtr = max(ATR, nanmean of the last 3 TR); NaN-only / zero → ATR', () => {
    const tr = Float64Array.from([1.0, 2.0, N, 4.0, 0.5]);
    expect(V.effectiveAtr(1.0, tr, 4)).toBe(S.eff_atr_i4);        // mean(4, 0.5) = 2.25
    expect(V.effectiveAtr(1.0, tr, 2)).toBe(S.eff_atr_i2_nan);    // mean(1, 2) = 1.5
    expect(V.effectiveAtr(3.0, tr, 0)).toBe(S.eff_atr_i0);        // max(3, 1) = 3
    expect(V.effectiveAtr(2.5, Float64Array.from([N, N, N]), 2)).toBe(S.eff_atr_allnan);
    expect(V.effectiveAtr(2.5, Float64Array.from([0, 0, 0]), 2)).toBe(S.eff_atr_zero);
    expect([S.eff_atr_i4, S.eff_atr_i2_nan, S.eff_atr_allnan]).toEqual([2.25, 1.5, 2.5]);
  });
});

describe('quality and the best direction', () => {
  it('qualityOf: 2 + strength + aligned + vol_bonus + rsi_ok + strong HTF + ≥2 families − counter-trend, clamped 1..5', () => {
    const base = { aligned: false, rsiOk: false, hs: 0, s: 1, families: 1, trendOk: true };
    expect(V.qualityOf({ strength: 0, vol_bonus: false }, base)).toBe(2);
    expect(V.qualityOf({ strength: 1, vol_bonus: true }, { ...base, aligned: true, rsiOk: true })).toBe(5);   // 6 → 5
    expect(V.qualityOf({ strength: 0, vol_bonus: false }, { ...base, trendOk: false })).toBe(1);
    expect(V.qualityOf({ strength: 0, vol_bonus: false }, { ...base, hs: 2 })).toBe(3);
    expect(V.qualityOf({ strength: 0, vol_bonus: false }, { ...base, hs: -2 })).toBe(2);        // wrong side
    expect(V.qualityOf({ strength: 0, vol_bonus: false }, { ...base, s: -1, hs: -2 })).toBe(3);
    expect(V.qualityOf({ strength: 0, vol_bonus: false }, { ...base, hs: 1 })).toBe(2);         // side only: no bonus
    expect(V.qualityOf({ strength: 0, vol_bonus: false }, { ...base, families: 2 })).toBe(3);
  });
  it('pickBest: a strictly higher quality replaces the best → LONG (evaluated first) wins ties', () => {
    const L = { s: 1, quality: 3 }, Sh = { s: -1, quality: 3 };
    expect(V.pickBest([L, Sh])).toBe(L);
    expect(V.pickBest([L, { s: -1, quality: 4 }]).s).toBe(-1);
    expect(V.pickBest([null, Sh])).toBe(Sh);
    expect(V.pickBest([null, null])).toBeNull();
  });
});

describe('signalAt on the scenario frames equals the bot (pins.json)', () => {
  const sweep = (frame) => {
    const ctx = new V.VolumeContext(frame, new V.VolumeConfig());
    const out = [];
    for (let i = 0; i < ctx.n; i++) {
      const sg = V.signalAt(ctx, i, 'TEST', '1h');
      if (sg) out.push({ i, ...sg.toDict(), tp: sg.tp, risk_pct: sg.risk_pct });
    }
    return out;
  };
  for (const name of Object.keys(pins.scenarios)) {
    it(`${name}: ${pins.scenarios[name].signals.length} signal(s)`, () => {
      assertSame(sweep(F.SCENARIOS[name]()), pins.scenarios[name].signals, name);
    });
  }
  it('bounce_long_hammer: the full signal (LONG, q=4, EMA200 Bounce, reasons in order)', () => {
    const [sig] = sweep(F.SCENARIOS.bounce_long_hammer());
    expect(sig).toMatchObject({
      i: 270, direction: 'LONG', quality: 4, signal_type: 'EMA200 Bounce', setup: 'bounce', pattern: 'hammer', timeframe: '1h',
      rr: 2.0, is_counter_trend: false, aligned: false, alignment: '', squeeze: 0, htf_tf: '', htf_state: 0, confluence: [],
      ma_names: 'SMA 10/20/50', ema_names: 'EMA 50/200', ma_label: 'EMA200',
    });
    expect(sig.reasons.slice(0, 2)).toEqual(['отскок от EMA200: молот / пин-бар', 'объём на откате затухал (VSA)']);
    expect(sig.reasons[2]).toMatch(/^объём ×\d+\.\d от среднего$/);
    expect(sig.tp).toBe(sig.tp1);
    expect(sig.sl).toBeLessThan(sig.entry);
    expect(sig.tp1 < sig.tp2 && sig.tp2 < sig.tp3).toBe(true);
    expect(sig.risk_pct).toBe(Math.abs(sig.entry - sig.sl) / sig.entry * 100);
  });
  it('ribbon_short: SHORT signal mirrors the LONG one (reasons, pattern, TP ladder below entry)', () => {
    const [sig] = sweep(F.SCENARIOS.ribbon_short());
    expect(sig).toMatchObject({ direction: 'SHORT', signal_type: 'Ribbon Pullback', setup: 'ribbon', pattern: 'ribbon', ma_label: 'EMA 5–55' });
    expect(sig.sl).toBeGreaterThan(sig.entry);
    expect(sig.tp3 < sig.tp2 && sig.tp2 < sig.tp1 && sig.tp1 < sig.entry).toBe(true);
  });
});

describe('analyzeVolume guards and the VolumeSignal object', () => {
  it('min_bars (225): a 224-bar frame → null, 225 bars are analysed; i below min_bars − 1 → null', () => {
    const frame = F.SCENARIOS.bounce_long_hammer();
    expect(V.analyzeVolume('T', frame.prefix(223), new V.VolumeConfig(), '1h')).toBeNull();
    expect(V.analyzeVolume('T', frame.prefix(224), new V.VolumeConfig(), '1h')).toBeNull();   // no setup there, but analysed
    const ctx = new V.VolumeContext(frame, new V.VolumeConfig());
    expect(V.signalAt(ctx, 223)).toBeNull();
    expect(V.signalAt(ctx, 300)).toBeNull();                                                   // i >= n
    expect(V.signalAt(ctx, -1, 'T', '1h').direction).toBe('LONG');                             // negative index = from the end
    expect(V.analyzeVolume('T', frame, new V.VolumeConfig(), '1h').entry).toBe(frame.c[270]);
    expect(V.analyzeVolume('T', null, new V.VolumeConfig(), '1h')).toBeNull();
  });
  it('no enabled setup → null; bounce disabled → the bounce scenario gives nothing', () => {
    const frame = F.SCENARIOS.bounce_long_hammer();
    const none = V.VolumeConfig.fromParams({ setup_cross: false, setup_turn: false, setup_bounce: false, setup_golden: false, setup_ribbon: false });
    expect(V.analyzeVolume('T', frame, none, '1h')).toBeNull();
    expect(V.analyzeVolume('T', frame, V.VolumeConfig.fromParams({ setup_bounce: false }), '1h')).toBeNull();
  });
  it('min_quality above the setup quality → null; trend_filter off keeps it', () => {
    const frame = F.SCENARIOS.bounce_long_hammer();
    expect(V.analyzeVolume('T', frame, V.VolumeConfig.fromParams({ min_quality: 5 }), '1h')).toBeNull();
    expect(V.analyzeVolume('T', frame, V.VolumeConfig.fromParams({ trend_filter: false }), '1h').quality).toBe(4);
  });
  it('HTF: the opposite side blocks the direction, the strong side adds +1 and a reason; htf_tf comes from the timeframe map', () => {
    const frame = F.SCENARIOS.bounce_long_hammer();
    const cfg = new V.VolumeConfig();
    const up = Array.from({ length: 60 }, (_, j) => [F.T0 + j * 4 * F.H, 100 + j, 101 + j, 99 + j, 100 + j, 1]);
    const dfUp = F.toFrame(up);
    const dfDown = F.toFrame(up.map((b, j) => [b[0], 200 - j, 201 - j, 199 - j, 200 - j, 1]));
    const sig = V.analyzeVolume('T', frame, cfg, '1h', dfUp);
    expect(sig.quality).toBe(5);
    expect(sig.htf_state).toBe(2);
    expect(sig.htf_tf).toBe('4h');
    expect(sig.reasons).toContain('старший ТФ 4h: по тренду EMA50');
    expect(V.analyzeVolume('T', frame, cfg, '1h', dfDown)).toBeNull();
    expect(V.analyzeVolume('T', frame, cfg, '1h', dfUp.prefix(27)).htf_state).toBe(0);         // < 29 rows → no HTF
    expect(V.analyzeVolume('T', frame, cfg.replace({ use_htf: false }), '1h', dfUp).htf_state).toBe(0);
  });
  it('VolumeSignal: dataclass field order, tp / volume_ratio / risk_pct properties', () => {
    const sig = new V.VolumeSignal({
      symbol: 'S', direction: 'LONG', entry: 100.0, sl: 98.0, tp1: 102.0, tp2: 104.0, tp3: 106.0, rr: 2.0, quality: 4,
      signal_type: 'MA Cross 10/20', rsi: 50.0, vol_ratio: 1.5, ema_fast: 1, ema_slow: 1, ema_trend: 1, atr: 1, timeframe: '',
      is_counter_trend: false, reasons: [], setup: 'cross', ma_label: '', ma_value: 0.0, ma_slow: 0.0, ema_mid: 0.0, aligned: false,
      squeeze: 0, alignment: '', htf_tf: '', htf_state: 0, confluence: [], pattern: '', ma_names: '', ema_names: '',
    });
    const sp = pins.sig_props;
    expect(sig.tp).toBe(sp.tp);
    expect(sig.risk_pct).toBe(sp.risk_pct);
    expect(sig.volume_ratio).toBe(sp.volume_ratio);
    expect(Object.keys(sig.toDict())).toEqual(sp.asdict_keys);
    expect(V.SIGNAL_FIELDS).toEqual(sp.asdict_keys);
    sig.entry = 0.0;
    expect(sig.risk_pct).toBe(sp.risk_pct_zero_entry);
    expect(Object.keys(sig.toDict())).not.toContain('tp');
  });
});

describe('golden fixture spot check (SYNUP01 default, bar 248)', () => {
  it('reproduces the recorded Ribbon Pullback signal', () => {
    const expected = load.loadExpected('volume');
    const want = expected.fixtures['SYNUP01-USDT-SWAP'].default.signals[0];
    expect(want.i).toBe(248);
    const frames = load.loadFrames('SYNUP01-USDT-SWAP');
    const b = load.barInputs(frames, 248);
    const cfg = V.VolumeConfig.fromParams({});
    const sig = V.analyzeVolume('SYNUP01-USDT-SWAP', b.df, cfg, '1h', b.dfHtf4h);
    expect(sig.signal_type).toBe('Ribbon Pullback');
    expect(sig.quality).toBe(want.quality);
    expect(sig.reasons).toEqual(want.reasons);
    expect(sig.htf_state).toBe(2);
    expect(Math.abs(sig.entry - want.entry) <= 1e-9 * want.entry).toBe(true);
    expect(V.scannerPostSteps(sig, b.df, cfg)).toEqual({ squeeze_score: 0, quality_after_squeeze: want.quality, passes_ctx_gate: true });
  });
});
