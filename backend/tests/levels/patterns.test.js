/**
 * patterns.test.js — LEVELS candle patterns, institutional tiers, approach quality and
 * test counting (M5) against the bot's own Python output.
 *
 * fixtures/frames.json (gen_frames.js) holds crafted + seeded-random frames and case
 * tables; fixtures/expected.json (gen_expected.py, pinned venv) is what
 * indicator.CHMIndicator._detect_pattern / _detect_institutional_pattern /
 * _assess_approach_quality / _count_recent_tests returned for them, plus the
 * relax-mode (bull_pat, bear_pat) seen by the setup search. Every block asserts the
 * readable pins AND full equality with Python over the whole table.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Frame } from '../../strategies/common/frame.js';
import S from '../../strategies/common/series.js';
import P from '../../strategies/levels/patterns.js';

const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
const FX = JSON.parse(fs.readFileSync(path.join(FIX, 'frames.json'), 'utf8'));
const EXP = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
const F = (name) => Frame.fromBars(FX.frames[name]);
const { PATTERN, INST, APPROACH } = P;

describe('_detect_pattern (spec §8)', () => {
  it('readable pins of every branch of the if/elif chain', () => {
    const pat = (name) => P.detectPattern(F(name));
    expect(pat('pat_bull_pin')).toEqual({ bull: PATTERN.BULL_PIN, bear: '' });
    expect(pat('pat_bear_pin')).toEqual({ bull: '', bear: PATTERN.BEAR_PIN });
    expect(pat('pat_bull_engulf')).toEqual({ bull: PATTERN.BULL_ENGULF, bear: '' });
    expect(pat('pat_bear_engulf')).toEqual({ bull: '', bear: PATTERN.BEAR_ENGULF });
    expect(pat('pat_dragonfly')).toEqual({ bull: PATTERN.BULL_DOJI, bear: '' });
    expect(pat('pat_gravestone')).toEqual({ bull: '', bear: PATTERN.BEAR_DOJI });
    expect(pat('pat_neutral_doji')).toEqual({ bull: '', bear: '' });          // doji branch taken, no wick bias → chain ends
    expect(pat('pat_hammer')).toEqual({ bull: PATTERN.HAMMER, bear: '' });
    expect(pat('pat_inv_hammer')).toEqual({ bull: '', bear: PATTERN.INV_HAMMER });
    expect(pat('pat_inside_bull')).toEqual({ bull: PATTERN.INSIDE_BULL, bear: '' });
    expect(pat('pat_inside_bear')).toEqual({ bull: '', bear: PATTERN.INSIDE_BEAR });
    expect(pat('pat_inside_flat')).toEqual({ bull: '', bear: '' });           // zero body → doji path, symmetric wicks → nothing
    expect(pat('pat_morning_star')).toEqual({ bull: PATTERN.MORNING_STAR, bear: '' });
    expect(pat('pat_evening_star')).toEqual({ bull: '', bear: PATTERN.EVENING_STAR });
    expect(pat('pat_zero_range')).toEqual({ bull: '', bear: '' });            // total_c < 1e-10
    expect(pat('pat_zero_body_bull_wick')).toEqual({ bull: PATTERN.BULL_DOJI, bear: '' }); // QUIRK: body 0 → pin needs uw < 0 → doji
    expect(pat('pat_short3')).toEqual({ bull: '', bear: '' });                // < 4 bars
    expect(pat('pat_weak_bull')).toEqual({ bull: '', bear: '' });             // no classic pattern
  });

  it('matches Python on every pattern frame (crafted + 60 random)', () => {
    for (const name of FX.pattern_frames) {
      const got = P.detectPattern(F(name));
      expect([got.bull, got.bear], name).toEqual(EXP.patterns[name]);
    }
  });

  it('relax mode: weak patterns only when nothing else matched and len ≥ 3 (spec §8.2)', () => {
    expect(P.detectWeakPattern(F('pat_weak_bull'))).toEqual({ bull: PATTERN.WEAK_BULL, bear: '' });
    expect(P.detectWeakPattern(F('pat_weak_bear'))).toEqual({ bull: '', bear: PATTERN.WEAK_BEAR });
    expect(P.detectWeakPattern(F('pat_zero_range'))).toEqual({ bull: '', bear: '' });   // body/total ≤ 1e-10
    expect(P.detectWeakPattern(F('pat_inside_flat'))).toEqual({ bull: '', bear: '' });  // body 0
    expect(P.detectWeakPattern(Frame.fromBars(FX.frames.pat_short3.slice(0, 2)))).toEqual({ bull: '', bear: '' });
    for (const name of FX.pattern_frames) {
      const df = F(name);
      let { bull, bear } = P.detectPattern(df);
      if (!bull && !bear && df.length >= 3) ({ bull, bear } = P.detectWeakPattern(df));
      expect([bull, bear], name).toEqual(EXP.weak_patterns[name]);
    }
  });
});

describe('_detect_institutional_pattern (spec §9.5)', () => {
  const caseByFrame = (name) => FX.institutional_cases.findIndex((c) => c.frame === name);
  const run = (c) => P.detectInstitutionalPattern(F(c.frame), c.level, c.direction, c.vol_ratio, c.zone_buf);

  it('tier pins A → D for LONG and SHORT', () => {
    const pin = (name, want) => {
      const i = caseByFrame(name);
      expect(run(FX.institutional_cases[i]), name).toEqual(want);
      expect([want.name, want.bonus], name).toEqual(EXP.institutional[i]);
    };
    pin('inst_sweep', { name: INST.LIQUIDITY_SWEEP, bonus: 3 });
    pin('inst_ob', { name: INST.INSTITUTIONAL_ORDERBLOCK, bonus: 3 });
    pin('inst_fakeout_pin', { name: INST.FAKEOUT_PINBAR, bonus: 2 });
    pin('inst_engulf', { name: INST.ENGULFING_AT_LEVEL, bonus: 2 });
    pin('inst_pinbar', { name: INST.PINBAR_AT_LEVEL, bonus: 1 });
    pin('inst_sfp', { name: INST.FAKEOUT_PINBAR, bonus: 2 });   // the deep wick is also a pin bar → tier B wins
    pin('inst_sfp2', { name: INST.SFP, bonus: 1 });
    pin('inst_breakout_retest', { name: INST.BREAKOUT_RETEST, bonus: 0 });
    pin('inst_bounce_plain', { name: INST.BOUNCE_PLAIN, bonus: 0 });
    pin('inst_sweep_short', { name: INST.LIQUIDITY_SWEEP, bonus: 3 });
    pin('inst_ob_short', { name: INST.INSTITUTIONAL_ORDERBLOCK, bonus: 3 });
    pin('inst_fakeout_pin_short', { name: INST.FAKEOUT_PINBAR, bonus: 2 });
    pin('inst_engulf_short', { name: INST.ENGULFING_AT_LEVEL, bonus: 2 });
    pin('inst_pinbar_short', { name: INST.PINBAR_AT_LEVEL, bonus: 1 });
    pin('inst_sfp_short', { name: INST.SFP, bonus: 1 });
    pin('inst_short4', { name: '', bonus: 0 });                 // < 5 bars
  });

  it('matches Python on all cases (random frames × 3 levels × 2 directions × 4 volume ratios)', () => {
    const seen = new Set();
    FX.institutional_cases.forEach((c, i) => {
      const got = run(c);
      expect([got.name, got.bonus], `${c.frame} ${c.direction} ${c.vol_ratio} ${c.level}`).toEqual(EXP.institutional[i]);
      seen.add(got.name);
    });
    for (const k of Object.values(INST)) expect(seen.has(k), k).toBe(true);
  });
});

describe('_assess_approach_quality (spec §9.6)', () => {
  const run = (c) => {
    const df = F(c.frame);
    return P.assessApproachQuality(df, c.level, c.zone_buf, S.rollingMean(df.v, c.vol_len, c.vol_len), c.inst);
  };
  const byName = (name, inst = '') => FX.approach_cases.findIndex((c) => c.frame === name && c.inst === inst);

  it('rejections in order (impulse unless A-tier, vertical, over-tested) and the positive flags', () => {
    const pin = (name, inst, want) => {
      const i = byName(name, inst);
      expect(run(FX.approach_cases[i]), `${name}/${inst}`).toEqual(want);
      expect([want.ok, want.reason], name).toEqual(EXP.approach[i]);
    };
    pin('appr_impulse', '', { ok: false, reason: APPROACH.IMPULSE });
    pin('appr_impulse', 'SFP', { ok: false, reason: APPROACH.IMPULSE });
    pin('appr_impulse', 'LIQUIDITY_SWEEP', { ok: false, reason: APPROACH.overTested(9) });     // exempt → next rule
    pin('appr_impulse', 'INSTITUTIONAL_ORDERBLOCK', { ok: false, reason: APPROACH.overTested(9) });
    pin('appr_vertical_up', '', { ok: false, reason: APPROACH.VERTICAL });
    pin('appr_vertical_down', '', { ok: false, reason: APPROACH.VERTICAL });
    pin('appr_over_tested', '', { ok: false, reason: 'Уровень тестировался 4× подряд — ожидается пробой' });
    pin('appr_consolidation', '', { ok: true, reason: APPROACH.CONSOLIDATION });
    pin('appr_decay_decline', '', { ok: true, reason: `${APPROACH.VOL_DECLINING} | ${APPROACH.SIZE_DECAYING}` });
    pin('appr_neutral', '', { ok: true, reason: APPROACH.NEUTRAL });
    pin('appr_short5', '', { ok: true, reason: APPROACH.NOT_ENOUGH_DATA });
  });

  it('matches Python on all cases (incl. vol_ma NaN → avg_vol 1.0 and zero volumes)', () => {
    FX.approach_cases.forEach((c, i) => {
      const got = run(c);
      expect([got.ok, got.reason], `${c.frame} ${c.inst} ${c.level} vol_len=${c.vol_len}`).toEqual(EXP.approach[i]);
    });
    const reasons = new Set(EXP.approach.map((r) => r[1].slice(0, 12)));
    expect(reasons.size).toBeGreaterThanOrEqual(7);
  });
});

describe('_count_recent_tests (spec §9.7)', () => {
  it('counts ENTRIES into the band over the lookback (incl. bar −1)', () => {
    const c = FX.tests_cases;
    expect(P.countRecentTests(F(c[0].frame), c[0].level, c[0].zone_pct, c[0].lookback)).toBe(2);   // in,in,out,in,out → 2 entries
    expect(P.countRecentTests(F(c[1].frame), c[1].level, c[1].zone_pct, 2)).toBe(1);             // last two bars: in,out → 1
    expect(P.countRecentTests(F(c[2].frame), c[2].level, c[2].zone_pct, 3)).toBe(1);             // out,in,out
    expect(P.countRecentTests(F(c[3].frame), c[3].level, 3.0, 30)).toBe(EXP.tests[3]);          // wide band (±3): the 103 prefix dips in and out
    expect(P.countRecentTests(F(c[0].frame), c[0].level, c[0].zone_pct)).toBe(2);                // default lookback 30
  });

  it('matches Python on all cases', () => {
    FX.tests_cases.forEach((c, i) => {
      expect(P.countRecentTests(F(c.frame), c.level, c.zone_pct, c.lookback), `${c.frame} ${c.level} ${c.zone_pct} ${c.lookback}`).toBe(EXP.tests[i]);
    });
  });
});

describe('_check_fakeout', () => {
  it('LONG: low < lvl − 0.5·zb and close > lvl; SHORT mirrored', () => {
    const df = Frame.fromBars([[0, 100, 100.4, 99.5, 100.2, 1]]);
    expect(P.checkFakeout(df, 100, 'LONG', 0.7)).toBe(true);
    expect(P.checkFakeout(df, 100, 'LONG', 1.2)).toBe(false);   // 99.5 ≥ 99.4
    expect(P.checkFakeout(df, 100.3, 'SHORT', 0.1)).toBe(true); // high 100.4 > 100.35, close 100.2 < 100.3
    expect(P.checkFakeout(df, 100, 'SHORT', 0.7)).toBe(false);
  });
});
