/**
 * zones.test.js — LEVELS zone detection (M5) against the bot's own layer dump
 * (tests/golden/dumps/zones.json: `indicator._get_zones` per swept bar for 3 fixtures,
 * default IndConfig) plus unit pins of the psychological-level / class rules.
 *
 * For every dumped bar the JS `getZones` must reproduce sup/res zones (every public
 * key: price, hits, eff_hits, age_bars, class, is_psychological, layers, has_hvn,
 * has_lvn_to_tp), kde_peaks, hvn, lvn and atr_now after the fixture rounding (r10).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import load from '../golden/load.js';
import S from '../../strategies/common/series.js';
import F from '../../strategies/common/pyfmt.js';
import { Frame } from '../../strategies/common/frame.js';
import C from '../../strategies/levels/config.js';
import Z from '../../strategies/levels/zones.js';

const { loadFrames, barInputs, GOLDEN_DIR } = load;
const { r10 } = F;

const DUMP = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, 'dumps', 'zones.json'), 'utf8'));
const ZONE_KEYS = ['price', 'hits', 'eff_hits', 'age_bars', 'class', 'is_psychological', 'layers', 'has_hvn', 'has_lvn_to_tp'];

function roundZone(z) {
  const out = {};
  for (const k of ZONE_KEYS) out[k] = k === 'price' ? r10(z[k]) : z[k];
  return out;
}

describe('LEVELS zones vs dumps/zones.json (3 fixtures × 200 bars)', () => {
  const ic = DUMP.ind_config;

  it('the dump was produced with the default IndConfig', () => {
    expect(ic).toEqual(C.defaultIndConfig());
  });

  for (const [symbol, bars] of Object.entries(DUMP.fixtures)) {
    it(`${symbol}: sup/res zones, kde_peaks, hvn, lvn, atr_now are r10-identical on every bar`, () => {
      const frames = loadFrames(symbol);
      const failures = [];
      let zonesSeen = 0;
      for (const [iStr, want] of Object.entries(bars)) {
        const b = barInputs(frames, Number(iStr));
        const df = b.df;
        const atr = S.atrEmaSpan(df.h, df.l, df.c, ic.ATR_PERIOD);
        const atrNow = atr[atr.length - 1];
        if (r10(atrNow) !== want.atr_now) failures.push(`bar ${iStr} atr_now ${atrNow} != ${want.atr_now}`);
        const z = Z.getZones(df, ic.PIVOT_STRENGTH, atrNow, ic.ZONE_BUFFER);
        const kde = z.kdePeaks.map(r10);
        if (JSON.stringify(kde) !== JSON.stringify(want.kde_peaks)) failures.push(`bar ${iStr} kde_peaks ${JSON.stringify(kde)} != ${JSON.stringify(want.kde_peaks)}`);
        if (JSON.stringify(z.hvn.map(r10)) !== JSON.stringify(want.hvn)) failures.push(`bar ${iStr} hvn differ`);
        if (JSON.stringify(z.lvn.map(r10)) !== JSON.stringify(want.lvn)) failures.push(`bar ${iStr} lvn differ`);
        if (z.pivotsRes.length + z.pivotsSup.length !== want.n_pivots) failures.push(`bar ${iStr} n_pivots ${z.pivotsRes.length + z.pivotsSup.length} != ${want.n_pivots}`);
        for (const side of ['sup', 'res']) {
          const got = z[side].map(roundZone);
          const exp = want[side];
          if (JSON.stringify(got) !== JSON.stringify(exp)) {
            failures.push(`bar ${iStr} ${side} zones differ:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(exp)}`);
          }
          zonesSeen += exp.length;
          // every zone carries a working lvn_checker closure (non-enumerable, like the dump's `_zone_public`)
          for (const zone of z[side]) {
            expect(typeof zone.lvn_checker).toBe('function');
            expect(Object.keys(zone)).toEqual(ZONE_KEYS);
          }
        }
        if (failures.length > 10) break;
      }
      if (failures.length) throw new Error(`${failures.length} mismatches:\n${failures.slice(0, 10).join('\n')}`);
      expect(zonesSeen).toBeGreaterThan(0);
    });
  }

  it('lvn_checker reports an LVN strictly between two prices (either order)', () => {
    const frames = loadFrames('BTC-USDT-SWAP');
    const b = barInputs(frames, 300);
    const want = DUMP.fixtures['BTC-USDT-SWAP']['300'];
    const atr = S.atrEmaSpan(b.df.h, b.df.l, b.df.c, ic.ATR_PERIOD);
    const z = Z.getZones(b.df, ic.PIVOT_STRENGTH, atr[atr.length - 1], ic.ZONE_BUFFER);
    const zone = z.sup[0] || z.res[0];
    expect(want.lvn.length).toBeGreaterThan(0);
    const lv = z.lvn[0];
    expect(zone.lvn_checker(lv - 1, lv + 1)).toBe(true);
    expect(zone.lvn_checker(lv + 1, lv - 1)).toBe(true);
    expect(zone.lvn_checker(lv, lv + 1)).toBe(false); // strict
    // copies keep the closure, dumps don't see it
    const c = Z.copyZone(zone);
    expect(typeof c.lvn_checker).toBe('function');
    expect(JSON.stringify(c)).toBe(JSON.stringify(Z.zonePublic(zone)));
  });
});

describe('psychological levels and level class (spec §7.5)', () => {
  it('_is_psychological_level: step ≥ 1 % of price, within 0.3 % of a multiple', () => {
    expect(Z.isPsychologicalLevel(0)).toBe(false);
    expect(Z.isPsychologicalLevel(-5)).toBe(false);
    expect(Z.isPsychologicalLevel(100.0)).toBe(true);     // mag 1..100 all exact multiples
    expect(Z.isPsychologicalLevel(100.25)).toBe(true);    // 0.25 % from 100 (mag 1 is 1 % of price → allowed)
    expect(Z.isPsychologicalLevel(100.5)).toBe(false);    // 0.5 % from both 100 and 101
    expect(Z.isPsychologicalLevel(54074.02938)).toBe(true);  // dump: BTC zone 54074 → 50000-step? no: mag 1000 → rem 74 → 0.137 %
    expect(Z.isPsychologicalLevel(56384.62073)).toBe(false); // dump: BTC zone not psychological
    expect(Z.isPsychologicalLevel(55088.35681)).toBe(true);  // dump
    expect(Z.isPsychologicalLevel(3.615331535)).toBe(false); // dump SYNLV04: 3.6153 — mag 1 > price×0.01=0.036 ok; rem .615 → 0.38 → >0.3 %
    expect(Z.isPsychologicalLevel(6.571020706e-05)).toBe(false); // mag 1 > price×10 → break immediately
    // 250 → mag 25/50: exact multiple
    expect(Z.isPsychologicalLevel(250)).toBe(true);
    // 333.4: mag 1 is < 1 % of 333.4 → skipped; mag 5: rem 3.4 → min(3.4,1.6)/333.4 = 0.48 % → False (PSY-LEVEL-FIX)
    expect(Z.isPsychologicalLevel(333.4)).toBe(false);
  });

  it('_classify_level: first-match rules on eff_hits / age / layers', () => {
    expect(Z.classifyLevel(1, 2, 500, true, 1)).toBe(1);   // psych + hits ≥ 2
    expect(Z.classifyLevel(1, 1, 500, true, 1)).toBe(2);   // psych alone
    expect(Z.classifyLevel(1, 3, 30, false, 1)).toBe(1);   // 3 hits within 30 bars
    expect(Z.classifyLevel(1, 3, 31, false, 1)).toBe(2);   // … but age 31 → rule 5
    expect(Z.classifyLevel(1, 1, 500, false, 3)).toBe(1);  // 3 layers
    expect(Z.classifyLevel(1, 2, 100, false, 2)).toBe(2);
    expect(Z.classifyLevel(1, 2, 101, false, 2)).toBe(3);  // decayed
    expect(Z.classifyLevel(1, 1, 5, false, 1)).toBe(3);
    expect(Z.CLASS_NAMES).toEqual({ 1: 'Абсолютный', 2: 'Сильный', 3: 'Рабочий' });
  });

  it('fractal pivots: ties count, strict window, age = n−1−i', () => {
    const h = [1, 2, 5, 5, 2, 1, 1, 1, 1];
    const l = [1, 0, 0.5, 0.5, 0.2, 0.9, 0.9, 0.9, 0.9];
    const p = Z.fractalPivots(Float64Array.from(h), Float64Array.from(l), 2);
    expect(p.res).toEqual([[5, 6], [5, 5]]);
    expect(p.sup).toEqual([[0.2, 4]]); // the low 0 at i=1 lies outside the strict window [strength, n−strength)
  });

  it('clustering chains on the distance to the LAST appended point and keeps hits ≥ 2 or psychological', () => {
    // monotone highs/lows (never a pivot) with three equal lows at 100 and two highs 0.2 apart
    const n = 60;
    const bars = [];
    for (let i = 0; i < n; i++) {
      let hi = 105 - i * 0.001;
      let lo = 101 + i * 0.001;
      if (i === 10 || i === 25 || i === 40) lo = 100;      // three support touches at 100
      if (i === 18) hi = 110; if (i === 33) hi = 110.2;    // two resistance touches 0.2 apart
      bars.push([i * 3_600_000, 103, hi, lo, 103, 10]);
    }
    const df = Frame.fromBars(bars);
    const z = Z.getZones(df, 3, 1.0, 0.3); // buffer = 0.3
    expect(z.sup.length).toBe(1);
    expect(z.sup[0].price).toBe(100);
    expect(z.sup[0].hits).toBe(3);
    expect(z.sup[0].age_bars).toBe(n - 1 - 40);
    expect(z.sup[0].is_psychological).toBe(true);
    expect(z.sup[0].class).toBe(1);
    expect(z.res.length).toBe(1);
    expect(z.res[0].hits).toBe(2);
    expect(z.res[0].price).toBe((110 + 110.2) / 2);
    // with a buffer smaller than the gap the two highs do not chain → 1 hit each; both survive only
    // because 110 and 110.2 are psychological (mag 5: rem 0 / 0.2 → < 0.3 % of price). Five pivots
    // make the KDE layer run; its peak near 110.1 confirms both (eff_hits 3) → class 1 via rule 1.
    const z2 = Z.getZones(df, 3, 1.0, 0.1);
    expect(z2.res.map((x) => [x.price, x.hits, x.eff_hits, x.class])).toEqual([[110, 1, 3, 1], [110.2, 1, 3, 1]]);
    // a non-round single touch is dropped
    const bars3 = bars.map((b) => (b[2] === 110.2 ? [b[0], b[1], 110.7, b[3], b[4], b[5]] : b));
    const z3 = Z.getZones(Frame.fromBars(bars3), 3, 1.0, 0.1);
    expect(z3.res.map((x) => x.price)).toEqual([110]);
  });

  it('markHtfConfluence marks ±0.5·ATR matches as MTF copies (class ≤ 2) and leaves others untouched', () => {
    const sup = [{ price: 100, hits: 2, class: 3 }, { price: 120, hits: 2, class: 1 }];
    const res = [{ price: 150, hits: 2, class: 3 }];
    const htfSup = [{ price: 100.4 }];
    const htfRes = [{ price: 149 }];
    const m = Z.markHtfConfluence(sup, res, htfSup, htfRes, 1.0); // tol 0.5
    expect(m.sup[0]).toEqual({ price: 100, hits: 2, class: 2, mtf_label: 'MTF', timeframes: ['ltf', 'htf'] });
    expect(m.sup[1]).toBe(sup[1]);              // same object, untouched
    expect(m.res[0]).toBe(res[0]);              // 149 vs 150 > tol
    expect(sup[0].class).toBe(3);               // the cache is never mutated
    const none = Z.markHtfConfluence(sup, res, [], [], 1.0);
    expect(none.sup).toBe(sup);
    expect(none.res).toBe(res);
  });

  it('zone cache wrapper: TTL by TF, pre-filter at 2×MAX_DIST_PCT, eviction order', () => {
    expect(Z.zoneCacheTtl('1h')).toBe(1800);
    expect(Z.zoneCacheTtl('1d')).toBe(7200);
    expect(Z.zoneCacheTtl('2h')).toBe(900);
    expect(Z.preFilterSkip([{ price: 100 }], [], 104, 1.5)).toBe(true);   // 4 % > 3 %
    expect(Z.preFilterSkip([{ price: 100 }], [], 102, 1.5)).toBe(false);
    expect(Z.preFilterSkip([], [], 102, 1.5)).toBe(false);
    const cache = new Z.ZoneCache({ max: 2 });
    cache.store('A', 1000, [], [], 1800);
    cache.store('B', 1100, [], [], 1800);
    expect(cache.lookup('A', 2000, 1800)).toBeTruthy();
    expect(cache.lookup('A', 2900, 1800)).toBeNull();
    cache.store('C', 1200, [], [], 1800);        // over cap: nothing expired at 1200 → evict oldest (A)
    expect(cache.map.has('A')).toBe(false);
    expect(cache.map.has('B')).toBe(true);
    cache.store('D', 5000, [], [], 1800);        // B and C expired at 5000 → both evicted first
    expect([...cache.map.keys()]).toEqual(['D']);
  });
});
