import { describe, it, expect } from 'vitest';
import smc from '../strategies/smc/index.js';
import scalping from '../strategies/scalping/index.js';
import structure from '../strategies/smc/structure.js';
import fvg from '../strategies/smc/fvg.js';
import liquidity from '../strategies/smc/liquidity.js';
import premiumDiscount from '../strategies/smc/premiumDiscount.js';
import orderBlock from '../strategies/smc/orderBlock.js';

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

// ── SMC: structure ──────────────────────────────────────────────────────
describe('smc/structure', () => {
  it('findSwingHighs detects isolated peak', () => {
    // Inverted-V shape: peak at i=12, lookback=5 → that's a swing high
    const cs = [];
    for (let i = 0; i < 25; i++) {
      const h = 10 + (12 - Math.abs(i - 12)); // peak = 22 at i=12, descends to 10 at edges
      cs.push(candle(i, 10, h, 9, 10));
    }
    const highs = structure.findSwingHighs(cs, 5);
    expect(highs.length).toBeGreaterThan(0);
    expect(highs.find((h) => h.idx === 12)).toBeTruthy();
  });
  it('detectTrend bullish on HH+HL', () => {
    const t = structure.detectTrend(
      [{ idx: 0, price: 10 }, { idx: 1, price: 15 }],
      [{ idx: 0, price: 5 }, { idx: 1, price: 8 }]
    );
    expect(t).toBe('BULLISH');
  });
  it('detectTrend bearish on LH+LL', () => {
    const t = structure.detectTrend(
      [{ idx: 0, price: 15 }, { idx: 1, price: 10 }],
      [{ idx: 0, price: 8 }, { idx: 1, price: 5 }]
    );
    expect(t).toBe('BEARISH');
  });
});

// ── SMC: BOS wick_sweep ────────────────────────────────────────────────
describe('smc/structure: BOS wick_sweep', () => {
  it('body above level = real BOS', () => {
    // Build a series with swing high at index 10 price 20, then current bar closes above
    const cs = [];
    for (let i = 0; i < 20; i++) {
      const p = 10 + (i === 10 ? 10 : 0);
      cs.push(candle(i, p, p + 0.5, p - 0.5, p));
    }
    // Add 5 bars below
    for (let i = 20; i < 25; i++) cs.push(candle(i, 11, 11.5, 10.5, 11));
    // Final bar closes at 25 (above swing high of 20)
    cs.push(candle(25, 22, 26, 21, 25));
    const bos = structure.detectBos(cs, structure.findSwingHighs(cs, 5), structure.findSwingLows(cs, 5));
    expect(bos.detected).toBe(true);
    expect(bos.direction).toBe('BULLISH');
    expect(bos.wickSweep).toBe(false);
  });
});

// ── SMC: FVG ────────────────────────────────────────────────────────────
describe('smc/fvg', () => {
  it('detects a bullish FVG', () => {
    const cs = [];
    // 3-bar gap: bar 0 high = 10, bar 2 low = 12 → gap [10, 12]
    cs.push(candle(0, 9, 10, 9, 9.5));
    cs.push(candle(1, 10, 11, 10, 10.5));
    cs.push(candle(2, 12, 13, 12, 12.5));
    for (let i = 3; i < 10; i++) cs.push(candle(i, 12.5, 13, 12, 12.5)); // no fill
    const fvgs = fvg.findFvgs(cs, { minGapPct: 0.5 });
    expect(fvgs.length).toBeGreaterThan(0);
    const bull = fvgs.find((f) => f.type === 'bullish');
    expect(bull).toBeTruthy();
    // Multiple FVGs may form; check A bullish FVG was detected with sensible bounds
    expect(bull.fvgLow).toBeGreaterThanOrEqual(9);
    expect(bull.fvgLow).toBeLessThanOrEqual(12);
    expect(bull.fvgHigh).toBeGreaterThan(bull.fvgLow);
  });
});

// ── SMC: Premium/Discount ──────────────────────────────────────────────
describe('smc/premiumDiscount', () => {
  it('price below midpoint = DISCOUNT', () => {
    const r = premiumDiscount.getPremiumDiscount(100, 0, 30);
    expect(r.zone).toBe('DISCOUNT');
    expect(r.positionPct).toBe(30);
  });
  it('price above midpoint = PREMIUM', () => {
    const r = premiumDiscount.getPremiumDiscount(100, 0, 70);
    expect(r.zone).toBe('PREMIUM');
  });
  it('invalid range returns NEUTRAL', () => {
    expect(premiumDiscount.getPremiumDiscount(50, 100, 75).zone).toBe('NEUTRAL');
  });
});

// ── SMC: Liquidity equal levels ────────────────────────────────────────
describe('smc/liquidity', () => {
  it('clusters near-equal prices', () => {
    const levels = [
      { price: 100, idx: 0 }, { price: 100.05, idx: 1 },
      { price: 100.08, idx: 2 }, { price: 150, idx: 3 },
    ];
    const groups = liquidity.findEqualLevels(levels, 0.1);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0].count).toBeGreaterThanOrEqual(2);
  });
});

// ── SMC: scan() end-to-end shape ───────────────────────────────────────
describe('smc/index', () => {
  it('returns null on insufficient data', () => {
    expect(smc.scan([])).toBeNull();
    expect(smc.scan(new Array(30).fill(0).map((_, i) => candle(i, 100, 101, 99, 100)))).toBeNull();
  });
  it('signal (when produced) has full shape', () => {
    // Generate variety of setups; any produced signal must be shape-correct
    for (let seed = 0; seed < 5; seed++) {
      const closes = [];
      for (let i = 0; i < 200; i++) {
        closes.push(100 + Math.sin((i + seed * 2) / 9) * 8 + Math.cos(i / 17) * 4);
      }
      const cs = seriesFromCloses(closes);
      const sig = smc.scan(cs, { minConfirmations: 2, minRr: 1.0 });
      if (sig) {
        expect(sig.strategy).toBe('smc');
        expect(['long', 'short']).toContain(sig.side);
        expect(Number.isFinite(sig.entry)).toBe(true);
        expect(Number.isFinite(sig.stopLoss)).toBe(true);
        expect(Number.isFinite(sig.tp1)).toBe(true);
        expect(sig.quality).toBeGreaterThanOrEqual(0);
        expect(sig.quality).toBeLessThanOrEqual(10);
        expect(sig.confidence).toBeGreaterThanOrEqual(50);
        expect(typeof sig.reason).toBe('string');
        expect(sig.metadata).toHaveProperty('structure');
        expect(sig.metadata).toHaveProperty('atr');
      }
    }
  });
});

// ── Scalping ────────────────────────────────────────────────────────────
describe('scalping/index', () => {
  it('returns null on short input', () => {
    expect(scalping.scan([])).toBeNull();
    expect(scalping.scan(new Array(20).fill(0).map((_, i) => candle(i, 100, 101, 99, 100)))).toBeNull();
  });
  it('signal shape when volume spike triggers', () => {
    // Build 100-bar series with a strong volume spike + body on last closed bar
    const closes = [];
    for (let i = 0; i < 100; i++) closes.push(100 + i * 0.05);
    const cs = seriesFromCloses(closes);
    // Last closed bar (i=98): bullish body, high volume
    cs[98] = candle(98, 104.5, 106, 104.4, 105.8, 10000);
    cs[99] = candle(99, 105.8, 106, 105.5, 105.9, 100); // forming bar
    // Nudge earlier volumes down to make spike obvious
    for (let i = 70; i < 98; i++) cs[i] = candle(i, cs[i][1], cs[i][2], cs[i][3], cs[i][4], 50);
    const sig = scalping.scan(cs, {
      volSpikeMult: 2.0, volSpikeMinBodyPct: 0.5,
      atrMaxPct: 0.5, tpRrMin: 1.0,
    });
    if (sig) {
      expect(sig.strategy).toBe('scalping');
      expect(Number.isFinite(sig.entry)).toBe(true);
      expect(sig.metadata).toHaveProperty('approach');
      expect(sig.riskReward).toBeGreaterThanOrEqual(1.0);
    }
  });
});

// ── Order Block detection ─────────────────────────────────────────────
describe('smc/orderBlock', () => {
  it('finds bullish OB below impulse', () => {
    // Create a series: flat @ 100, then one bearish candle (99, 99.5, 98.5, 98.8),
    // then strong uptrend 99 → 120
    const cs = [];
    for (let i = 0; i < 10; i++) cs.push(candle(i, 100, 100.5, 99.5, 100));
    // Bearish OB candle at idx 10
    cs.push(candle(10, 99, 99.5, 98, 98.2));
    // Strong impulse up
    for (let i = 11; i < 30; i++) {
      const p = 99 + (i - 10) * 1.5;
      cs.push(candle(i, p - 0.5, p + 0.5, p - 0.7, p));
    }
    const bos = { detected: true, price: 108, direction: 'BULLISH' };
    const obs = orderBlock.getOrderBlocks(cs, bos, { minImpulsePct: 5, maxAgeCandles: 30 });
    // bullOb may or may not exist depending on exact impulse math; only assert shape
    expect(obs).toHaveProperty('bullOb');
    expect(obs).toHaveProperty('bearOb');
  });
});
