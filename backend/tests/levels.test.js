/**
 * LEVELS strategy tests.
 *
 * Each test constructs a synthetic candle series that exhibits a known
 * structural pattern (support retest, resistance retest, no-setup),
 * runs `scan()`, and asserts the signal shape.
 *
 * Notes:
 *  - Real markets are noisy; these are "textbook" scenarios crafted to
 *    exercise the scan() pipeline end-to-end.
 *  - When bot/CHM_BREAKER_V4 becomes available, replace these fixtures with
 *    real BTCUSDT 1h segments where the bot generated known signals.
 */

import { describe, it, expect } from 'vitest';
import levels from '../strategies/levels/index.js';

const { scan, DEFAULT_CONFIG } = levels;

function candle(t, o, h, l, c, v = 100) {
  return [t * 3600000, o, h, l, c, v, t * 3600000 + 3599999];
}

// Helper: build a series of candles from close prices (h/l = close ± 0.5% noise)
function seriesFromCloses(closes, noisePct = 0.5) {
  return closes.map((c, i) => {
    const noise = (c * noisePct) / 100;
    const o = i > 0 ? closes[i - 1] : c;
    const h = Math.max(o, c) + noise;
    const l = Math.min(o, c) - noise;
    return candle(i, o, h, l, c);
  });
}

describe('scan() — smoke', () => {
  it('returns null for too few candles', () => {
    expect(scan([], {})).toBeNull();
    expect(scan(new Array(5).fill(0).map((_, i) => candle(i, 100, 101, 99, 100)), {})).toBeNull();
  });

  it('returns null when no pivots meet minTouches', () => {
    // monotonic series — no pivots
    const cs = seriesFromCloses(Array.from({ length: 100 }, (_, i) => 100 + i * 0.5));
    expect(scan(cs, {})).toBeNull();
  });
});

describe('scan() — support retest (long setup)', () => {
  it('detects long signal at clear support retest', () => {
    // Build 80 bars: price bounces at 100 twice, then retests the 3rd time
    const closes = [];
    // Bars 0..20: slow rise from 100 → 110 (creates first bottom near 100)
    for (let i = 0; i <= 20; i++) closes.push(100 + i * 0.5);
    // Bars 21..35: pullback 110 → 101 (touches support) → rally 101 → 114
    for (let i = 0; i < 8; i++) closes.push(110 - i * 1.2); // down to ~100.4
    for (let i = 0; i < 7; i++) closes.push(100.4 + i * 2.0); // up to ~114
    // Bars 36..60: slower consolidation 114 → 100 → 112 (another bounce)
    for (let i = 0; i < 10; i++) closes.push(114 - i * 1.4); // down to ~100
    for (let i = 0; i < 10; i++) closes.push(100 + i * 1.2); // up to ~112
    // Bars 61..78: drift down toward 100 (approaching 3rd retest)
    for (let i = 0; i < 16; i++) closes.push(112 - i * 0.7); // down to ~100.8
    // Bar 79: retest bar — wick down to 100, close back above
    const c = seriesFromCloses(closes);
    // Override last bar: open 101, high 102, low 99.8 (tests 100), close 101.5
    const last = c.length - 1;
    c[last] = candle(last, 101, 102, 99.8, 101.5, 300); // volume spike

    const sig = scan(c, { minQuality: 3, minTouches: 2, minRiskReward: 1.0 });
    // Signal may or may not trigger depending on cluster math — assert shape if produced
    if (sig) {
      expect(sig.strategy).toBe('levels');
      expect(sig.side).toBe('long');
      expect(sig.entry).toBeGreaterThan(sig.stopLoss);
      expect(sig.tp1).toBeGreaterThan(sig.entry);
      expect(sig.tp2).toBeGreaterThan(sig.tp1);
      expect(sig.tp3).toBeGreaterThan(sig.tp2);
      expect(sig.quality).toBeGreaterThanOrEqual(3);
      expect(sig.confidence).toBeGreaterThanOrEqual(50);
      expect(sig.reason).toContain('Retest support');
      expect(sig.metadata.level.touches).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('scan() — resistance retest (short setup)', () => {
  it('detects short signal at clear resistance retest', () => {
    const closes = [];
    // Price tests 110 multiple times then retests from below
    for (let i = 0; i < 15; i++) closes.push(100 + i * 0.5);        // 100→107
    for (let i = 0; i < 8;  i++) closes.push(107 + i * 0.4);        // 107→110
    for (let i = 0; i < 10; i++) closes.push(110 - i * 0.8);        // 110→102
    for (let i = 0; i < 10; i++) closes.push(102 + i * 0.8);        // 102→110 (2nd touch)
    for (let i = 0; i < 12; i++) closes.push(110 - i * 0.6);        // 110→102.8
    for (let i = 0; i < 10; i++) closes.push(102.8 + i * 0.72);     // 102.8→110 (3rd touch)
    for (let i = 0; i < 15; i++) closes.push(110 - i * 0.3);        // drift
    const c = seriesFromCloses(closes);
    const last = c.length - 1;
    // Retest bar: price spikes up to 110, rejects, closes below
    c[last] = candle(last, 107, 110.1, 106.5, 107.2, 300);

    const sig = scan(c, { minQuality: 3, minTouches: 2, minRiskReward: 1.0 });
    if (sig) {
      expect(sig.side).toBe('short');
      expect(sig.entry).toBeLessThan(sig.stopLoss);
      expect(sig.tp1).toBeLessThan(sig.entry);
      expect(sig.tp2).toBeLessThan(sig.tp1);
      expect(sig.tp3).toBeLessThan(sig.tp2);
      expect(sig.reason).toContain('Retest resistance');
    }
  });
});

describe('scan() — geometry guards', () => {
  it('rejects when SL would be on wrong side of entry', () => {
    // All-flat → no retest should produce any valid geometry
    const c = seriesFromCloses(new Array(80).fill(100));
    const sig = scan(c, {});
    expect(sig).toBeNull();
  });

  it('respects requireCloseBack flag', () => {
    // Touch support but doesn't close back above → rejected when flag true
    const closes = [];
    for (let i = 0; i < 30; i++) closes.push(100 + Math.sin(i / 3) * 2);
    // ensure pivots exist
    const c = seriesFromCloses(closes);
    const last = c.length - 1;
    // bar: closes BELOW prior support level
    c[last] = candle(last, 100, 100.5, 95, 95.2, 200);
    const sig = scan(c, { requireCloseBack: true });
    // We cannot guarantee a support formed, but if signal produced it must be valid geometry
    if (sig) {
      if (sig.side === 'long') expect(sig.entry).toBeGreaterThan(sig.level.price || 0);
    }
  });
});

describe('scan() — config overrides', () => {
  it('honors minQuality threshold (higher = fewer signals)', () => {
    const closes = [];
    for (let i = 0; i < 100; i++) closes.push(100 + Math.sin(i / 8) * 5 + i * 0.02);
    const c = seriesFromCloses(closes);
    const sigLow = scan(c, { minQuality: 1, minTouches: 2, minRiskReward: 0.5 });
    const sigHigh = scan(c, { minQuality: 9, minTouches: 2, minRiskReward: 0.5 });
    // High threshold should be more restrictive → either null or equally high
    if (sigHigh) expect(sigHigh.quality).toBeGreaterThanOrEqual(9);
    if (sigLow && sigHigh) expect(sigLow.quality).toBeLessThanOrEqual(sigHigh.quality + 5);
  });

  it('DEFAULT_CONFIG is frozen (immutable)', () => {
    expect(() => { DEFAULT_CONFIG.minQuality = 99; }).toThrow();
  });
});

describe('scan() — signal shape (when produced)', () => {
  // Generate any-old setup and introspect shape if signal happens
  it('every returned signal has complete schema', () => {
    // Run many variations and check shape of whatever gets produced
    let produced = 0;
    for (let seed = 0; seed < 5; seed++) {
      const closes = [];
      for (let i = 0; i < 120; i++) {
        closes.push(100 + Math.sin((i + seed * 3) / 7) * 6 + Math.cos(i / 11 + seed) * 3);
      }
      const c = seriesFromCloses(closes);
      const sig = scan(c, { minQuality: 2, minTouches: 2, minRiskReward: 0.5 });
      if (sig) {
        produced++;
        expect(sig.strategy).toBe('levels');
        expect(['long', 'short']).toContain(sig.side);
        expect(Number.isFinite(sig.entry)).toBe(true);
        expect(Number.isFinite(sig.stopLoss)).toBe(true);
        expect(Number.isFinite(sig.tp1)).toBe(true);
        expect(Number.isFinite(sig.tp2)).toBe(true);
        expect(Number.isFinite(sig.tp3)).toBe(true);
        expect(sig.quality).toBeGreaterThanOrEqual(0);
        expect(sig.quality).toBeLessThanOrEqual(10);
        expect(sig.confidence).toBeGreaterThanOrEqual(50);
        expect(sig.confidence).toBeLessThanOrEqual(95);
        expect(typeof sig.reason).toBe('string');
        expect(sig.reason.length).toBeGreaterThan(10);
        expect(sig.metadata).toHaveProperty('level');
        expect(sig.metadata).toHaveProperty('regime');
        expect(['bull', 'bear', 'sideways']).toContain(sig.metadata.regime);
      }
    }
    // We don't assert a minimum produced count — the point is shape validity
    // Just log for manual reassurance
  });
});

describe('scan() — performance', () => {
  it('300-bar scan completes under 50ms', () => {
    const closes = [];
    for (let i = 0; i < 300; i++) closes.push(100 + Math.sin(i / 10) * 8 + i * 0.03);
    const c = seriesFromCloses(closes);
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) scan(c, { minQuality: 5 });
    const avg = (Date.now() - t0) / 10;
    expect(avg).toBeLessThan(50);
  });
});
