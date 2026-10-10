/**
 * VOLUME detectors on hand-built frames (frames.js): every scenario is swept bar by bar
 * in both directions with all five detectors and the hit list must equal — exactly, every
 * float bit-identical — what the bot's volume_strategy.py produced on the same frames
 * (pins.json). The gate-rejection variants (low volume, wick missing the EMA) must
 * produce the pinned "nothing".
 */
import { describe, it, expect } from 'vitest';
import V from '../../strategies/volume/index.js';
import F from './frames.js';
import P from './pins.js';
import prodPython from '../common/prodPython.js';

const Q = V.quality;   // the instance the engine modules require (not a second ESM copy)

const { pins, assertSame } = P;

it('pins.json comes from the production interpreter (CPython 3.11)', () => {
  expect(pins.python).toMatch(prodPython.PROD_PYTHON);
  expect(pins._provenance).toContain(`python ${pins.python},`);
});

/** Every hit of every detector on every bar/direction, in the generator's order (Python dict order). */
function allHits(frame, cfg = new V.VolumeConfig()) {
  const ctx = new V.VolumeContext(frame, cfg);
  const hits = [];
  for (let i = 0; i < ctx.n; i++) {
    for (const s of [1, -1]) {
      for (const key of ['golden', 'bounce', 'cross', 'turn', 'ribbon']) {
        const h = V.DETECTORS[key](ctx, i, s);
        if (h !== null) hits.push({ i, s, ...h });
      }
    }
  }
  return hits;
}

/** Run `fn` with the batch-D env of one generator case (env_ctx: the other keys unset). */
function withEnv(env, fn) {
  Q.setEnv(env);
  try { return fn(); } finally { Q.setEnv(null); }
}

describe('detector sweeps equal the bot output (pins.json)', () => {
  for (const name of Object.keys(pins.scenarios)) {
    it(`${name}: ${pins.scenarios[name].hits.length} hit(s)`, () => {
      const frame = F.SCENARIOS[name]();
      expect(frame.length).toBe(pins.scenarios[name].n);
      withEnv({}, () => assertSame(allHits(frame), pins.scenarios[name].hits, name));
    });
    it(`${name}: VOLUME_MIN_SETUP_VOL_MULT=0 → the pre-floor hits (${pins.scenarios[name].hits_nofloor.length})`, () => {
      const off = { VOLUME_MIN_SETUP_VOL_MULT: '0' };
      withEnv(off, () => assertSame(allHits(F.SCENARIOS[name](), new V.VolumeConfig()), pins.scenarios[name].hits_nofloor, name));
    });
  }
});

describe('one scenario per setup (what the pins contain)', () => {
  const hitsOf = (name) => allHits(F.SCENARIOS[name]());

  it('MA Cross: SMA10 crosses SMA20 on bar 66, both directions mirrored', () => {
    const [h] = hitsOf('cross_long');
    expect(h).toMatchObject({
      i: 66, s: 1, key: 'cross', label: 'MA Cross 10/20', ma_label: 'SMA10/SMA20', strength: 0, vol_bonus: false,
      reasons: ['SMA10 пересекла SMA20 снизу вверх', 'цена выше SMA50'],
    });
    expect(h.pattern).toBeUndefined();
    const [hs] = hitsOf('cross_short');
    expect(hs).toMatchObject({ i: 66, s: -1, reasons: ['SMA10 пересекла SMA20 сверху вниз', 'цена ниже SMA50'] });
    expect(hitsOf('cross_long_lowvol')).toEqual([]);                     // vr < vol_mult
  });

  it('MA Turn: SMA20 slope flips on bar 62 (the V also yields a cross at 64; its ×1.36 golden cross at 68 is under the [VOL-MIN-VOLUME] floor)', () => {
    const hits = hitsOf('turn_long');
    expect(hits.map((h) => [h.i, h.key])).toEqual([[62, 'turn'], [64, 'cross']]);
    expect(pins.scenarios.turn_long.hits_nofloor.map((h) => [h.i, h.key])).toEqual([[62, 'turn'], [64, 'cross'], [68, 'golden']]);
    expect(hits[0]).toMatchObject({
      label: 'MA Turn SMA20', ma_label: 'SMA20', strength: 0,
      reasons: ['SMA20 развернулась вверх после 5+ свечей', 'цена выше SMA50'],
    });
    expect(hitsOf('turn_short')[0].reasons).toEqual(['SMA20 развернулась вниз после 5+ свечей', 'цена ниже SMA50']);
    expect(hitsOf('turn_long_lowvol').map((h) => h.key)).toEqual(['cross']);   // the turn needs vol_mult 1.5×, the golden the floor
  });

  it('Golden / Death Cross on bar 293, volume ≥ ×1.5 ([VOL-MIN-VOLUME]; the ×1.36 bar fired before the floor), strength 1', () => {
    expect(hitsOf('golden_long')).toEqual([]);
    expect(hitsOf('golden_short')).toEqual([]);
    const [g] = hitsOf('golden_long_spike');
    expect(g).toMatchObject({
      i: 293, s: 1, key: 'golden', label: 'Golden Cross', ma_label: 'EMA50/EMA200', strength: 1,
      reasons: ['EMA50 пересекла EMA200 снизу вверх (золотой крест)'],
    });
    const [d] = hitsOf('golden_short_spike');
    expect(d).toMatchObject({ label: 'Death Cross', reasons: ['EMA50 пересекла EMA200 сверху вниз (крест смерти)'] });
    expect(hitsOf('golden_long_lowvol')).toEqual([]);
  });

  it('EMA200 Bounce: hammer, dry pullback volume (VSA), sl_anchor = the EMA', () => {
    const [h] = hitsOf('bounce_long_hammer');
    expect(h).toMatchObject({
      i: 270, s: 1, key: 'bounce', label: 'EMA200 Bounce', ma_label: 'EMA200', strength: 1, vol_bonus: true, pattern: 'hammer',
      reasons: ['отскок от EMA200: молот / пин-бар', 'объём на откате затухал (VSA)'],
    });
    expect(h.sl_anchor).toBe(h.ma_value);
    expect(hitsOf('bounce_short_hammer')[0].reasons[0]).toBe('отскок от EMA200: перевёрнутый пин-бар');
    expect(hitsOf('bounce_long_hammer_lowvol')).toEqual([]);
    expect(hitsOf('bounce_long_hammer_miss')).toEqual([]);                // low 1.0 above the EMA: dist > tol
  });

  it('[VOLUME-EMA-TOUCH] touch variant on the EMA200 (strength 1) and on the EMA50 (strength 0)', () => {
    expect(hitsOf('bounce_long_touch200')[0]).toMatchObject({
      label: 'EMA200 Bounce', strength: 1, pattern: 'touch', reasons: ['отскок от EMA200: касание EMA и закрытие выше', 'объём на откате затухал (VSA)'],
    });
    expect(hitsOf('bounce_short_touch')[0]).toMatchObject({
      label: 'EMA50 Bounce', ma_label: 'EMA50', strength: 0, pattern: 'touch', reasons: ['отскок от EMA50: касание EMA и закрытие ниже', 'объём на откате затухал (VSA)'],
    });
    expect(hitsOf('bounce_long_touch')[0].reasons[0]).toBe('отскок от EMA50: касание EMA и закрытие выше');
  });

  it('Ribbon Pullback: ordered ribbon, pullback inside it, close back over the EMA5, RSI 35–65, volume ≥ ×1.5', () => {
    expect(hitsOf('ribbon_long')).toEqual([]);                            // ×1.36 < the [VOL-MIN-VOLUME] floor
    const [h] = hitsOf('ribbon_long_spike');
    expect(h).toMatchObject({ i: 288, s: 1, key: 'ribbon', label: 'Ribbon Pullback', ma_label: 'EMA 5–55', pattern: 'ribbon', vol_bonus: true });
    expect(h.reasons[0]).toMatch(/^откат к ленте EMA 5…55: лента выстроена на \d+%, возврат над EMA5$/);
    expect(h.reasons[1]).toBe('объём на откате затухал (VSA)');
    expect(hitsOf('ribbon_short_spike')[0].reasons[0]).toMatch(/возврат под EMA5$/);
    expect(hitsOf('ribbon_long_lowvol')).toEqual([]);
  });

  it('a constant frame triggers nothing (every MA equal, RSI = 50 by the NaN rule)', () => {
    expect(hitsOf('flat')).toEqual([]);
    const ctx = new V.VolumeContext(F.SCENARIOS.flat(), new V.VolumeConfig());
    expect(ctx.rsi[59]).toBe(50.0);
    expect(ctx.e50[59]).toBe(100);
  });

  it('setup_ribbon=false leaves ctx.rib null and the ribbon detector returns null', () => {
    const cfg = V.VolumeConfig.fromParams({ setup_ribbon: false });
    const ctx = new V.VolumeContext(F.SCENARIOS.ribbon_long_spike(), cfg);
    expect(ctx.rib).toBeNull();
    expect(V.setupRibbon(ctx, 288, 1)).toBeNull();
  });
});

describe('_rejection and _ribbon_order (pins.json)', () => {
  const bar = (o, h, l, c) => [o, h, l, c];
  const ctxOf = (bars) => ({
    o: Float64Array.from(bars, (b) => b[0]), h: Float64Array.from(bars, (b) => b[1]),
    l: Float64Array.from(bars, (b) => b[2]), c: Float64Array.from(bars, (b) => b[3]),
  });
  const R = pins.rejection;
  it('hammer: tail ≥ 2·max(body, 0.05·range), nose ≤ 0.35·range', () => {
    expect(V.rejection(ctxOf([bar(10, 10.2, 9.0, 10.1)]), 0, 1)).toBe(R.hammer_long);
    expect(V.rejection(ctxOf([bar(10, 10.2, 9.0, 10.1)]), 0, -1)).toBe(R.hammer_long_as_short);
    expect(V.rejection(ctxOf([bar(10, 11.0, 9.9, 9.95)]), 0, -1)).toBe(R.hammer_short);
    expect(V.rejection(ctxOf([bar(10, 10.3, 9.0, 10.0)]), 0, 1)).toBe(R.doji_tail_rule);
    expect(V.rejection(ctxOf([bar(10, 10.8, 9.0, 10.1)]), 0, 1)).toBe(R.nose_too_big);
    expect(R.hammer_long).toBe('hammer');
    expect(R.nose_too_big).toBe('');
  });
  it('engulfing needs the previous bar: c > o, prev bearish, c ≥ prev open, o ≤ prev close', () => {
    expect(V.rejection(ctxOf([bar(10.5, 10.6, 9.9, 10.0), bar(9.95, 10.9, 9.9, 10.7)]), 1, 1)).toBe(R.engulf_long);
    expect(V.rejection(ctxOf([bar(10.5, 10.6, 9.9, 10.0), bar(10.05, 10.9, 9.9, 10.7)]), 1, 1)).toBe(R.engulf_long_open_above_prev_close);
    expect(V.rejection(ctxOf([bar(10.0, 10.6, 9.9, 10.5), bar(10.55, 10.6, 9.5, 9.8)]), 1, -1)).toBe(R.engulf_short);
    expect(V.rejection(ctxOf([bar(10.5, 10.6, 10.0, 10.1)]), 0, 1)).toBe(R.bearish_body_long);
    expect(V.rejection(ctxOf([bar(10, 10, 10, 10)]), 0, 1)).toBe(R.zero_range);
    expect(V.rejection(ctxOf([bar(9.95, 10.9, 9.9, 10.7)]), 0, 1)).toBe(R.engulf_needs_prev);
    expect(R.engulf_long).toBe('engulfing');
    expect(R.engulf_long_open_above_prev_close).toBe('');
  });
  it('ribbon order = ordered pairs / 28; any NaN → 0', () => {
    const cols = [[8, 7, 6, 5, 4, 3, 2, 1], [1, 2, 3, 4, 5, 6, 7, 8], [8, 7, 6, 5, 4, 3, 2, Number.NaN], [5, 5, 5, 5, 5, 5, 5, 5], [8, 7, 6, 5, 1, 2, 3, 4]];
    const rib = Array.from({ length: 8 }, (_, k) => Float64Array.from(cols, (col) => col[k]));
    const got = [];
    for (let j = 0; j < 5; j++) for (const s of [1, -1]) got.push(V.ribbonOrder(rib, j, s));
    expect(got).toEqual(pins.ribbon_order);
    expect(got[0]).toBe(1.0);
    expect(got[8]).toBe(22 / 28);
  });
});
