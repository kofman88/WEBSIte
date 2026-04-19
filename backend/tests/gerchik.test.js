import { describe, it, expect } from 'vitest';
import gerchik from '../strategies/gerchik/index.js';

const { scan, DEFAULT_CONFIG } = gerchik;

function candle(t, o, h, l, c, v = 100) {
  return [t * 3600000, o, h, l, c, v, t * 3600000 + 3599999];
}
function seriesFromCloses(closes, noisePct = 0.5) {
  return closes.map((c, i) => {
    const noise = (c * noisePct) / 100;
    const o = i > 0 ? closes[i - 1] : c;
    const h = Math.max(o, c) + noise;
    const l = Math.min(o, c) - noise;
    return candle(i, o, h, l, c);
  });
}

describe('gerchik.scan() — smoke', () => {
  it('is a pure function exposing DEFAULT_CONFIG', () => {
    expect(typeof scan).toBe('function');
    expect(DEFAULT_CONFIG).toBeTruthy();
    expect(DEFAULT_CONFIG.minTouches).toBe(3);
    expect(DEFAULT_CONFIG.requireTrendAlignment).toBe(true);
    expect(DEFAULT_CONFIG.requireAbsorption).toBe(true);
    expect(DEFAULT_CONFIG.minRiskReward).toBe(2.0);
  });

  it('returns null for too-few candles', () => {
    expect(scan([], {})).toBeNull();
    expect(scan(seriesFromCloses([100, 101, 102]), {})).toBeNull();
  });

  it('returns null on monotonic series (no levels)', () => {
    const cs = seriesFromCloses(Array.from({ length: 100 }, (_, i) => 100 + i * 0.5));
    expect(scan(cs, {})).toBeNull();
  });
});

describe('gerchik.scan() — strict filter enforcement', () => {
  function buildRetestSeries() {
    // Triple-bottom near 100 → 3rd retest with hammer + volume spike
    const closes = [];
    for (let i = 0; i <= 20; i++) closes.push(100 + i * 0.5);            // 100→110
    for (let i = 0; i < 8;  i++) closes.push(110 - i * 1.2);             // pullback → ~100.4
    for (let i = 0; i < 7;  i++) closes.push(100.4 + i * 2.0);           // → ~114
    for (let i = 0; i < 10; i++) closes.push(114 - i * 1.4);             // → 100
    for (let i = 0; i < 10; i++) closes.push(100 + i * 1.2);             // → 112
    for (let i = 0; i < 16; i++) closes.push(112 - i * 0.7);             // drift → 100.8
    const c = seriesFromCloses(closes);
    const last = c.length - 1;
    // Retest bar — hammer: body small at top, long lower wick, close above level
    c[last] = candle(last, 101, 101.5, 99.8, 101.3, 300);
    return c;
  }

  it('rejects when volume spike missing (volumeRatioMin not met)', () => {
    const c = buildRetestSeries();
    // Force volume on last bar to average (no spike)
    const last = c.length - 1;
    c[last] = candle(last, 101, 101.5, 99.8, 101.3, 80);
    const sig = scan(c, { minQuality: 0 });
    expect(sig).toBeNull();
  });

  it('rejects when absorption candle missing', () => {
    // Same retest geometry but the last bar is a normal body (no hammer)
    const c = buildRetestSeries();
    const last = c.length - 1;
    // Large body filling most of range → NOT a hammer
    c[last] = candle(last, 100.1, 101.5, 99.8, 101.4, 300);
    const sig = scan(c, { minQuality: 0 });
    expect(sig).toBeNull();
  });

  it('rejects when a 2-touch level (minTouches=3 enforced)', () => {
    // Only 2 visits to support
    const closes = [];
    for (let i = 0; i < 20; i++) closes.push(100 + i * 0.5);     // 100→110
    for (let i = 0; i < 10; i++) closes.push(110 - i);           // 110→100 (1st touch)
    for (let i = 0; i < 15; i++) closes.push(100 + i * 0.8);     // 100→112
    for (let i = 0; i < 12; i++) closes.push(112 - i);           // → 100 (2nd touch only)
    const c = seriesFromCloses(closes);
    const last = c.length - 1;
    c[last] = candle(last, 101, 101.5, 99.8, 101.3, 300); // hammer + volume
    const sig = scan(c, { minQuality: 0 });
    // Either null (filtered out) or not using this level
    if (sig) expect(sig.metadata.level.touches).toBeGreaterThanOrEqual(3);
  });

  it('rejects counter-trend when requireTrendAlignment=true', () => {
    // Strong downtrend bars, then a "support" retest — gerchik should reject
    const closes = [];
    for (let i = 0; i < 60; i++) closes.push(120 - i * 0.4);  // 120→96 (downtrend)
    for (let i = 0; i < 20; i++) closes.push(96 + Math.sin(i / 2) * 0.4);
    const c = seriesFromCloses(closes);
    const last = c.length - 1;
    c[last] = candle(last, 96.1, 96.5, 95.5, 96.3, 300);
    const sig = scan(c, { minQuality: 0 });
    // Gerchik should either return null, or be short (trend-aligned)
    if (sig) expect(sig.side).toBe('short');
  });
});

describe('gerchik.scan() — shape when produced', () => {
  it('emits strategy=gerchik and confidence ≥60 if signal produced', () => {
    // Fabricate any candle array — if it emits a signal, shape must be right
    const closes = [];
    for (let i = 0; i < 50; i++) closes.push(100 + Math.sin(i / 4) * 3 + i * 0.1);
    const c = seriesFromCloses(closes);
    const last = c.length - 1;
    c[last] = candle(last, 101, 101.5, 99.8, 101.3, 300);
    const sig = scan(c, { minQuality: 0, minRiskReward: 0.5, minTouches: 2, requireTrendAlignment: false, requireAbsorption: false });
    if (sig) {
      expect(sig.strategy).toBe('gerchik');
      expect(sig.confidence).toBeGreaterThanOrEqual(60);
      expect(sig.entry).toBeGreaterThan(0);
      expect(sig.stopLoss).toBeGreaterThan(0);
      expect(sig.tp1).toBeGreaterThan(0);
      expect(sig.reason).toContain('KRP');
      expect(sig.metadata).toHaveProperty('volumeRatio');
      expect(sig.metadata).toHaveProperty('regime');
    }
  });
});

describe('gerchik.scan() — performance', () => {
  it('runs under 50ms on 300 candles', () => {
    const c = seriesFromCloses(Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 5) * 5));
    const t0 = Date.now();
    scan(c, {});
    expect(Date.now() - t0).toBeLessThan(50);
  });
});
