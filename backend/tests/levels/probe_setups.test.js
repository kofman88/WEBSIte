/**
 * probe_setups.test.js — LEVELS differential probe on hand-constructed setup frames
 * (tests/golden/levels_probe_setups.json.gz, `make_levels_probe.py --suite setups`).
 *
 * 21 tail designs × LONG/SHORT × 15m/4h on a clean synthetic range (one support zone near the
 * range low, one resistance zone near the high), each tail built in units of the zone buffer
 * z = L·0.3 % around the zone level L the bot finds:
 *   SFP (sweep > z + volume; LIQUIDITY_SWEEP and plain SFP tiers), Fakeout (0.5·z..z; FAKEOUT_PINBAR
 *   and LIQUIDITY_SWEEP), Bounce with every institutional tier (A ORDERBLOCK, B ENGULFING /
 *   FAKEOUT_PINBAR, C PINBAR, D BOUNCE_PLAIN via Hammer / Inside Bar / Morning Star and
 *   BREAKOUT_RETEST via a Dragonfly Doji), a weak-pattern bounce (LEVELS_RELAX_ENABLED only),
 *   Retest of the broken level and Breakout / Breakdown, plus 6 threshold edges (low = L − z,
 *   low = L − 0.5·z, close = L + 2·z, close = L − z, |low − L| = z, close = L + z) with no designed outcome.
 * The frames are stored in the probe file; every one is swept over its last 24 bars under 17
 * configurations (design config, prod gates, defaults, R:R floor, zone 0.7 / 0.15, HIGH_WR,
 * relaxed, vol/confirm gates + HTF, SL-V2, live cooldown, on-demand, memcoin / major aliases,
 * no BTC/ETH). The generator asserts that the bot hits every designed block at the last bar;
 * here the engine must reproduce every bar of every case, and the design table is pinned.
 */
import { it, expect } from 'vitest';
import { defineProbeSuite, replayCase } from './probeReplay.js';

const TYPES = {
  LONG: ['SFP (Захват ликвидности)', 'Ложный пробой (Fakeout)', 'Отскок от поддержки', 'Ретест пробитого уровня', 'Пробой уровня'],
  SHORT: ['SFP (Ложный пробой вверх)', 'Ложный пробой (Fakeout)', 'Отскок от сопротивления', 'Ретест пробитой поддержки', 'Пробой поддержки'],
};
const BOUNCE_TIERS = ['INSTITUTIONAL_ORDERBLOCK', 'ENGULFING_AT_LEVEL', 'FAKEOUT_PINBAR', 'PINBAR_AT_LEVEL', 'BOUNCE_PLAIN', 'BREAKOUT_RETEST'];

defineProbeSuite('levels_probe_setups', {
  title: 'setups (hand-constructed frames)',
  minCases: 30,
  extra: (getProbe) => {
    it('84 designed frames: 21 designs × LONG/SHORT × 15m/4h', () => {
      const frames = Object.values(getProbe().frames);
      expect(frames.length).toBe(84);
      for (const tf of ['15m', '4h']) {
        for (const dir of ['LONG', 'SHORT']) expect(frames.filter((m) => m.tf === tf && m.direction === dir).length).toBe(21);
      }
    });

    for (const tf of ['15m', '4h']) {
      it(`${tf}: the engine hits every designed setup block at the last bar, like the bot`, () => {
        const probe = getProbe();
        const check = (caseName, pick) => {
          const c = probe.cases[caseName];
          const res = replayCase(c, probe);
          expect(res.failures).toEqual([]);
          const got = new Map(res.records.filter((r) => r.last).map((r) => [r.src, r.record]));
          let n = 0;
          for (const [src, m] of Object.entries(probe.frames)) {
            if (m.tf !== tf || !pick(m)) continue;
            n++;
            const wantType = m.want_type || (m.direction === 'LONG' ? TYPES.LONG[2] : TYPES.SHORT[2]);
            const wantPattern = m.want_pattern || 'BOUNCE_PLAIN';
            const r = got.get(src);
            expect(r ? [r.direction, r.breakout_type, r.pattern] : [src, m.design, 'no signal']).toEqual([m.direction, wantType, wantPattern]);
          }
          return n;
        };
        // design config: 14 blocks × 2 directions; LEVELS_RELAX_ENABLED + relaxed: the weak-pattern bounce
        expect(check(`setup_${tf}_loose`, (m) => m.want_type !== null)).toBe(28);
        expect(check(`setup_${tf}_relax`, (m) => m.design === 'bounce_weak')).toBe(2);
      }, 120_000);

      it(`${tf}: every setup type and every bounce tier appears among the bot's signals`, () => {
        const probe = getProbe();
        const seen = new Set();
        for (const fx of Object.values(probe.cases[`setup_${tf}_loose`].fixtures)) {
          for (const s of fx.signals) seen.add(`${s.direction}|${s.breakout_type}|${s.pattern}`);
        }
        for (const dir of ['LONG', 'SHORT']) {
          for (const t of TYPES[dir]) expect([...seen].some((k) => k.startsWith(`${dir}|${t}|`)), `${dir} ${t}`).toBe(true);
          for (const p of BOUNCE_TIERS) expect(seen.has(`${dir}|${TYPES[dir][2]}|${p}`), `${dir} bounce ${p}`).toBe(true);
        }
      });
    }
  },
});
