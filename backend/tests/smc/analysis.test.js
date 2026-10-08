/**
 * analysis.test.js — SMC ANALYSIS layer (M3) on hand-built frames.
 *
 * fixtures/frames.json holds small deterministic candle frames; fixtures/expected.json
 * is what the bot's own Python code (smc/structure.py, liquidity.py, order_block.py,
 * fvg.py, premium_discount.py, analyzer.py, squeeze_detector.py) returned for them
 * (generated with the pinned venv, see the scratchpad generator in the M3 branch
 * notes). Every block asserts the pinned behaviour AND deep equality with Python.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Frame } from '../../strategies/common/frame.js';
import S from '../../strategies/common/series.js';
import { pyRound } from '../../strategies/common/pyround.js';
import { computeSqueezeScore } from '../../strategies/common/squeeze.js';
import { smcConfig, isUpperKey, analysisKey, configFromAnalysisKey, SMC_CONFIG_DEFAULTS } from '../../strategies/smc/config.js';
import { getMarketStructure, findSwingHighs, findSwingLows, detectTrend, detectBos, detectChoch } from '../../strategies/smc/structure.js';
import { findEqualLevels, detectLiquiditySweep, findLiquiditySweeps } from '../../strategies/smc/liquidity.js';
import { getOrderBlocks, findImpulseStart, findBreakerBlock } from '../../strategies/smc/orderBlock.js';
import { getFvgAnalysis, findFvgs, nearestFvg } from '../../strategies/smc/fvg.js';
import { getPremiumDiscount } from '../../strategies/smc/premiumDiscount.js';
import { analyze, SMCAnalyzer, smcDigest } from '../../strategies/smc/analyzer.js';

const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
const FRAMES = JSON.parse(fs.readFileSync(path.join(FIX, 'frames.json'), 'utf8'));
const EXPECTED = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));

const F = (name) => Frame.fromBars(FRAMES[name]);
const structureOf = (name) => getMarketStructure(F(name), 10, true, true);

describe('SMC config (SMCConfig / _analysis_key)', () => {
  it('copies class defaults and applies only UPPER-CASE kwargs (unknown upper-case keys ARE set, like Python)', () => {
    const c = smcConfig({ MIN_RR: 2.5, vol_mult: 9, _PRIVATE: 1, UNKNOWN_KEY: 'x', VOL_LEN: 20.0 });
    expect(c.MIN_RR).toBe(EXPECTED.config.MIN_RR);
    expect(c.VOL_MULT).toBe(EXPECTED.config.VOL_MULT);
    expect('vol_mult' in c).toBe(EXPECTED.config.has_vol_mult_lower);
    expect('_PRIVATE' in c).toBe(EXPECTED.config.has_private);
    expect(c.UNKNOWN_KEY).toBe(EXPECTED.config.UNKNOWN_KEY);
    expect(c.VOL_LEN).toBe(EXPECTED.config.VOL_LEN);
    expect(smcConfig()).toEqual({ ...SMC_CONFIG_DEFAULTS });
    expect(isUpperKey('OB_MAX_AGE_CANDLES')).toBe(true);
    expect(isUpperKey('Ob_Max')).toBe(false);
    expect(isUpperKey('_X')).toBe(false);
    expect(isUpperKey('123')).toBe(false);
  });

  it('analysis key = (FVG, CHOCH, BREAKER, int(OB_MAX_AGE), SWEEP_CLOSE, int(VOL_LEN)) and round-trips', () => {
    const key = analysisKey(smcConfig({ OB_MAX_AGE_CANDLES: 80.9, SWEEP_CLOSE_REQUIRED: 1, VOL_LEN: '20' }));
    expect(key).toEqual([true, true, true, 80, true, 20]);
    const cfg = configFromAnalysisKey([true, false, false, 50, false, 7]);
    expect(cfg.CHOCH_ENABLED).toBe(false);
    expect(cfg.OB_USE_BREAKER).toBe(false);
    expect(cfg.OB_MAX_AGE_CANDLES).toBe(50);
    expect(cfg.VOL_LEN).toBe(7);
    expect(cfg.OB_MIN_IMPULSE_PCT).toBe(0.15);   // untouched class default
  });
});

describe('structure: swings, trend, BOS / CHoCH states', () => {
  it('matches Python on every structure scenario', () => {
    for (const [name, want] of Object.entries(EXPECTED.structure)) {
      expect(structureOf(name), name).toEqual(want);
    }
    expect(getMarketStructure(F('htf_bearish_choch_up'), 10, true, false).choch).toEqual(EXPECTED.structure_choch_disabled.choch);
  });

  it('BEARISH trend + close above the last LH → BOS BULLISH and CHoCH UP on the same level (quirk)', () => {
    const s = structureOf('htf_bearish_choch_up');
    expect(s.trend).toBe('BEARISH');
    expect(s.bos).toMatchObject({ detected: true, direction: 'BULLISH', price: 106, bar_ago: 24, wick_sweep: false });
    expect(s.choch).toMatchObject({ detected: true, direction: 'UP', price: 106, bar_ago: 24 });
    expect(s.bos_wick_sweep).toBe(false);
    expect(s.choch_wick_sweep).toBe(false);
  });

  it('wick above the level without a body close → not detected, wick_sweep=True for both BOS and CHoCH', () => {
    const s = structureOf('htf_bearish_wick');
    expect(s.bos).toMatchObject({ detected: false, direction: 'BULLISH', price: 106, wick_sweep: true });
    expect(s.choch).toMatchObject({ detected: false, direction: 'UP', wick_sweep: true });
    expect(s.bos_wick_sweep).toBe(true);
    expect(s.choch_wick_sweep).toBe(true);
  });

  it('nothing broken → empty BOS/CHoCH (direction "", price 0, bar_ago 0)', () => {
    const s = structureOf('htf_bearish_none');
    expect(s.bos).toEqual({ detected: false, price: 0.0, direction: '', bar_ago: 0, wick_sweep: false });
    expect(s.choch).toEqual({ detected: false, price: 0.0, direction: '', bar_ago: 0, wick_sweep: false });
  });

  it('BULLISH trend: BOS up has no CHoCH; close below the last HL → BOS BEARISH + CHoCH DOWN; wick only → wick_sweep', () => {
    expect(structureOf('htf_bullish_bos').bos).toMatchObject({ detected: true, direction: 'BULLISH', price: 121, bar_ago: 14 });
    expect(structureOf('htf_bullish_bos').choch.detected).toBe(false);
    const d = structureOf('htf_bullish_choch_down');
    expect(d.bos).toMatchObject({ detected: true, direction: 'BEARISH', price: 99 });
    expect(d.choch).toMatchObject({ detected: true, direction: 'DOWN', price: 99 });
    const w = structureOf('htf_bullish_wick_down');
    expect(w.bos).toMatchObject({ detected: false, direction: 'BEARISH', wick_sweep: true });
    expect(w.choch).toMatchObject({ detected: false, direction: 'DOWN', wick_sweep: true });
  });

  it('fewer than lookback·3 bars → RANGING with empty swings and null last swings', () => {
    const s = structureOf('htf_short');
    expect(s.trend).toBe('RANGING');
    expect(s.swing_highs).toEqual([]);
    expect(s.last_swing_high).toBeNull();
    expect(s.last_swing_low).toBeNull();
  });

  it('swing ties count (an equal-high plateau yields several swings); trend needs 2+2 swings', () => {
    const bars = [];
    for (let i = 0; i < 41; i++) {
      const c = i >= 15 && i <= 17 ? 110 : 100 - Math.abs(i - 16) * 0.25;
      bars.push([i, c, i >= 15 && i <= 17 ? 112 : c + 0.5, c - 0.5, c, 1]);
    }
    const f = Frame.fromBars(bars);
    const sh = findSwingHighs(f, 10);
    expect(sh.map((x) => x.idx)).toEqual([15, 16, 17]);
    expect(sh[0].bar).toBe(40 - 15);
    expect(detectTrend(sh, findSwingLows(f, 10))).toBe('RANGING');
    expect(detectBos(f, [], sh, true).detected).toBe(false);
    expect(detectChoch(f, sh, []).detected).toBe(false);
  });
});

describe('liquidity: equal levels and sweeps on the closed bar', () => {
  it('matches Python for close_required True/False on the three sweep scenarios', () => {
    for (const [key, want] of Object.entries(EXPECTED.liquidity)) {
      const [name, cr] = key.split(':');
      const s = structureOf(name);
      const got = findLiquiditySweeps(F(name), s.swing_highs, s.swing_lows, 0.1, cr === '1', 0.3);
      expect(got, key).toEqual(want);
      expect(s.swing_highs.every((x) => x.type === 'high')).toBe(true);  // tagged in place
    }
  });

  it('equal-level grouping uses the first member as the reference and the mean as the price', () => {
    const g = findEqualLevels([{ price: 100, type: 'low' }, { price: 100.09, type: 'low' }, { price: 100.18, type: 'low' }, { price: 105, type: 'low' }], 0.1);
    // 100.18 is within 0.1 % of 100.09 but NOT of the reference 100 → new group (single → dropped)
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ count: 2, type: 'low' });
    expect(g[0].price).toBe((100 + 100.09) / 2);
    expect(findEqualLevels([], 0.1)).toEqual([]);
  });

  it('sweep up: wick through the equal low, close back above, wick ratio ≥ 0.3 → swept with wick_ratio = round(wr, 3)', () => {
    const l = EXPECTED.liquidity['htf_sweep_up:1'];
    expect(l.sweep_up).toEqual({ swept: true, level: 89.025, direction: 'UP', wick_ratio: 0.6 });
    expect(l.sweep_down.swept).toBe(false);
    expect(l.equal_lows.map((e) => e.price)).toEqual([89.025]);
    expect(l.equal_highs.map((e) => e.price)).toEqual([101]);
  });

  it('close_required gates the sweep: close below the level → not swept when required, swept (wr 0.475) when not', () => {
    expect(EXPECTED.liquidity['htf_sweep_up_noclose:1'].sweep_up.swept).toBe(false);
    expect(EXPECTED.liquidity['htf_sweep_up_noclose:0'].sweep_up).toMatchObject({ swept: true, wick_ratio: 0.475 });
    const s = structureOf('htf_sweep_up_noclose');
    const eq = findEqualLevels(s.swing_lows, 0.1)[0];
    expect(detectLiquiditySweep(F('htf_sweep_up_noclose'), eq, 'UP', true, 0.3).swept).toBe(false);
    expect(detectLiquiditySweep(F('htf_sweep_up_noclose'), eq, 'UP', false, 0.3).wick_ratio).toBe(pyRound(1.9 / 4, 3));
  });

  it('sweep down picks the first swept equal-high scanning from the top; short frames (< 5 bars) never sweep', () => {
    expect(EXPECTED.liquidity['htf_sweep_down:1'].sweep_down).toMatchObject({ swept: true, level: 101, wick_ratio: 0.87 });
    const tiny = Frame.fromBars(FRAMES.htf_sweep_up.slice(-4));
    expect(detectLiquiditySweep(tiny, { price: 89.025 }, 'UP', true, 0.3)).toEqual({ swept: false, level: 89.025, direction: 'UP', wick_ratio: 0.0 });
  });
});

describe('order blocks: detection, mitigation, 50 % retrace, breaker slot', () => {
  const BOS = { detected: true, price: 102.0, direction: 'BULLISH' };
  const NOBOS = { detected: false, price: 0.0, direction: '' };

  it('matches Python for both frames × bos/no-bos × breakers on/off', () => {
    for (const [key, want] of Object.entries(EXPECTED.ob)) {
      const [name, b, brk] = key.split(':');
      const got = getOrderBlocks(F(name), b === 'bos' ? BOS : NOBOS, 0.15, 60, true, brk === '1');
      expect(got, key).toEqual(want);
    }
  });

  it('bullish OB = last bearish candle before the impulse (≥ 0.15 %), with impulse FVG, mitigated by the last bar overlap', () => {
    const r = getOrderBlocks(F('mtf_ob_plain'), BOS, 0.15, 60, true, true);
    expect(r.bull_ob).toMatchObject({ found: true, type: 'bullish', ob_low: 99.8, ob_high: 101.5, ob_mid: (99.8 + 101.5) / 2, bar_ago: 7, mitigated: true, ob_50_reached: false, is_breaker: false });
    expect(r.bull_ob.impulse_fvg).toMatchObject({ type: 'bullish', fvg_low: 101.5, fvg_high: 102.0, idx: 4, bar_ago: 5 });
    expect(r.bull_ob.impulse_fvg.gap_pct).toBe(pyRound((102.0 - 101.5) / 101.5 * 100, 3));
    expect(r.bear_ob).toMatchObject({ found: true, type: 'bearish', ob_low: 102.8, ob_high: 104.0, bar_ago: 4, mitigated: true, ob_50_reached: false, impulse_fvg: null });
    expect(findImpulseStart(F('mtf_ob_plain'), 102.0, 'BULLISH', 60)).toBe(2);
    expect(findImpulseStart(F('mtf_ob_plain'), 102.0, 'BEARISH', 60)).toBe(8);
    expect(findImpulseStart(F('mtf_ob_plain'), 1.0, 'BULLISH', 60)).toBeNull();
  });

  it('no BOS → bull OB uses high[-1], bear OB uses low[-1] as the reference price', () => {
    const r = getOrderBlocks(F('mtf_ob_plain'), NOBOS, 0.15, 60, true, true);
    expect(r.bull_ob.found).toBe(true);
    expect(r).toEqual(EXPECTED.ob['mtf_ob_plain:nobos:1']);
  });

  it('a close below ob_low after the OB turns it into a bearish_breaker placed in the bear slot; the bull slot is marked found=False', () => {
    const r = getOrderBlocks(F('mtf_ob_breaker'), BOS, 0.15, 60, true, true);
    expect(r.bull_ob).toMatchObject({ found: false, type: 'bullish', ob_low: 99.8, ob_high: 101.5, is_breaker: false });
    expect(r.bear_ob).toMatchObject({ found: true, type: 'bearish_breaker', is_breaker: true, ob_low: 99.8, ob_high: 101.5, bar_ago: 7, mitigated: true, ob_50_reached: true });
    expect(r.bear_ob.impulse_fvg).toMatchObject({ idx: 4 });   // kept from the original OB
    // breakers off → the same OB stays a plain bullish OB in the bull slot
    const off = getOrderBlocks(F('mtf_ob_breaker'), BOS, 0.15, 60, true, false);
    expect(off.bull_ob).toMatchObject({ found: true, type: 'bullish', is_breaker: false });
    expect(off.bear_ob.found).toBe(false);
    // find_breaker_block alone: copy keeps found=True, recomputes flags with the new type
    const brk = findBreakerBlock(F('mtf_ob_breaker'), off.bull_ob, 'BULLISH');
    expect(brk).toMatchObject({ found: true, is_breaker: true, type: 'bearish_breaker' });
    expect(findBreakerBlock(F('mtf_ob_breaker'), { ...off.bull_ob, bar_ago: 0 }, 'BULLISH').is_breaker).toBe(false);
  });

  it('a real OB in the target slot wins over a breaker', () => {
    // bear slot holds a real bearish OB (mtf_ob_plain has no breaker) — nothing is swapped
    const r = getOrderBlocks(F('mtf_ob_plain'), BOS, 0.15, 60, true, true);
    expect(r.bear_ob.is_breaker).toBe(false);
    expect(r.bull_ob.found).toBe(true);
  });
});

describe('FVG / IFVG: fill rule, inversion, nearest by midpoint', () => {
  it('matches Python (inversed on/off)', () => {
    expect(getFvgAnalysis(F('ltf_fvg'), 0.08, true, false)).toEqual(EXPECTED.fvg);
    expect(getFvgAnalysis(F('ltf_fvg'), 0.08, false, false)).toEqual(EXPECTED.fvg_no_inverse);
  });

  it('partial fill does not count, a full traversal does (→ IFVG), an FVG on the last bar can never be filled', () => {
    const all = findFvgs(F('ltf_fvg'), 0.08, 'both', true);
    const byIdx = Object.fromEntries(all.map((f) => [f.idx, f]));
    expect(byIdx[2]).toMatchObject({ type: 'bullish', fvg_low: 101, fvg_high: 102, filled: false });   // low 101.5 dipped inside only
    expect(byIdx[4]).toMatchObject({ type: 'bullish', fvg_low: 103.5, fvg_high: 104.0, filled: true });  // low 103.2 ≤ 103.5
    expect(byIdx[8]).toMatchObject({ type: 'bearish', filled: false, bar_ago: 0 });
    expect(all.map((f) => f.idx)).toEqual([8, 7, 6, 4, 2]);   // freshest first
    const r = getFvgAnalysis(F('ltf_fvg'), 0.08, true, false);
    expect(r.all_fvgs.map((f) => f.idx)).toEqual([8, 7, 6, 2]);
    expect(r.ifvgs).toHaveLength(1);
    expect(r.ifvgs[0]).toMatchObject({ idx: 4, type: 'ifvg_bearish', inversed: true, filled: false });
    expect(r.bull_fvg.idx).toBe(2);
    expect(r.bear_fvg.idx).toBe(8);   // midpoint 102.6 is the closest to close 101.5
    expect(r.bull_found).toBe(true);
    expect(r.all_fvgs[0].gap_pct).toBe(pyRound((102.8 - 102.4) / 102.4 * 100, 3));
  });

  it('min gap threshold and nearest_fvg tie-breaking (first minimum wins)', () => {
    expect(findFvgs(F('ltf_fvg'), 0.2, 'both', true).map((f) => f.idx)).toEqual([8, 4, 2]);
    const a = { type: 'bullish', fvg_low: 99, fvg_high: 101, filled: false };
    const b = { type: 'ifvg_bullish', fvg_low: 99, fvg_high: 101, filled: false };
    expect(nearestFvg([a, b], 100, 'bullish')).toBe(a);
    expect(nearestFvg([{ ...a, filled: true }], 100, 'bullish')).toBeNull();
    expect(nearestFvg([{ type: 'bearish', fvg_low: 99, fvg_high: 101, filled: false }], 100, 'bullish')).toBeNull();
  });
});

describe('premium / discount', () => {
  it('matches Python, position_pct is Python-rounded to 1 decimal, zone decided on the raw value', () => {
    for (const c of EXPECTED.pd) {
      const got = getPremiumDiscount(c.in[0], c.in[1], c.in[2], 1.0);
      expect(got, JSON.stringify(c.in)).toEqual(c.out);
      if (c.in[0] > c.in[1]) {
        const raw = (c.in[2] - c.in[1]) / (c.in[0] - c.in[1]) * 100;
        expect(got.position_pct).toBe(pyRound(raw, 1));
        expect(got.zone).toBe(raw >= 50.0 ? 'PREMIUM' : 'DISCOUNT');
      } else {
        expect(got).toMatchObject({ zone: 'NEUTRAL', position_pct: 50.0, equilibrium: c.in[2] });
      }
    }
    expect(getPremiumDiscount(200, 100, 150).zone).toBe('PREMIUM');     // 50.0 → PREMIUM
    expect(getPremiumDiscount(200, 100, 149.95).position_pct).toBe(49.9); // 49.95 → 49.9 (binary below the tie)
  });
});

describe('analyzer: 3-TF orchestration, ATR, volume ratio, error capture, digest', () => {
  const KEY_CFG = configFromAnalysisKey([true, true, true, 80, true, 20]);

  it('full run matches Python (incl. the scanner squeeze injection)', () => {
    const a = analyze('TEST-USDT-SWAP', F('htf_sweep_up'), F('mtf_volume'), F('ltf_fvg'), KEY_CFG);
    a.squeeze_score = computeSqueezeScore(F('mtf_volume')) || 0;
    expect(a).toEqual(EXPECTED.analyze.full);
    expect(new SMCAnalyzer(KEY_CFG).analyze('TEST-USDT-SWAP', F('htf_sweep_up'), F('mtf_volume'), F('ltf_fvg'))).toEqual(analyze('TEST-USDT-SWAP', F('htf_sweep_up'), F('mtf_volume'), F('ltf_fvg'), KEY_CFG));
  });

  it('ATR = ewm(span=14, adjust=False) of the MTF true range; vol_avg = mean of the VOL_LEN bars BEFORE the last one', () => {
    const mtf = F('mtf_volume');
    const a = EXPECTED.analyze.full;
    const atr = S.atrEmaSpan(mtf.h, mtf.l, mtf.c, 14);
    expect(a.atr).toBe(atr[atr.length - 1]);
    const n = mtf.length;
    expect(a.vol_avg).toBe(S.seriesMean(mtf.v.subarray(n - 21, n - 1)));
    expect(a.vol_last).toBe(mtf.v[n - 1]);
    expect(a.vol_ratio).toBe(a.vol_last / a.vol_avg);
    expect(a.volume_ok).toBe(a.vol_ratio >= 1.2);
    expect(a.current_price).toBe(mtf.c[n - 1]);
    expect(a.current_high).toBe(mtf.h[n - 1]);
    expect(a.current_low).toBe(mtf.l[n - 1]);
  });

  it('VOL_LEN below 5 is raised to 5; FVG disabled → the four-key stub; LTF null → FVG on the MTF frame', () => {
    const v3 = analyze('TEST-USDT-SWAP', F('htf_sweep_up'), F('mtf_volume'), F('ltf_fvg'), smcConfig({ VOL_LEN: 3 }));
    expect(v3).toEqual(EXPECTED.analyze.vol_len_3);
    const mtf = F('mtf_volume');
    expect(v3.vol_avg).toBe(S.seriesMean(mtf.v.subarray(mtf.length - 6, mtf.length - 1)));
    const nf = analyze('TEST-USDT-SWAP', F('htf_sweep_up'), F('mtf_volume'), F('ltf_fvg'), smcConfig({ FVG_ENABLED: false }));
    expect(nf).toEqual(EXPECTED.analyze.fvg_disabled);
    expect(nf.fvg).toEqual({ bull_fvg: null, bear_fvg: null, bull_found: false, bear_found: false });
    const ln = analyze('TEST-USDT-SWAP', F('htf_sweep_up'), F('mtf_volume'), null, KEY_CFG);
    expect(ln).toEqual(EXPECTED.analyze.ltf_none);
  });

  it('short HTF → RANGING structure, NEUTRAL pd_zone {zone, position_pct: 50}, current price still from the MTF', () => {
    const s = analyze('TEST-USDT-SWAP', F('htf_short'), F('mtf_volume'), F('ltf_fvg'), KEY_CFG);
    expect(s).toEqual(EXPECTED.analyze.short_htf);
    expect(s.pd_zone).toEqual({ zone: 'NEUTRAL', position_pct: 50.0 });
    expect(s.structure.trend).toBe('RANGING');
    expect(s.current_price).toBe(F('mtf_volume').c[29]);
  });

  it('an exception is captured in analysis.error (pandas IndexError text on an empty MTF frame)', () => {
    const e = analyze('TEST-USDT-SWAP', F('htf_short'), F('mtf_volume').slice(0, 0), F('ltf_fvg'), KEY_CFG);
    expect(e).toEqual(EXPECTED.analyze.empty_mtf);
    expect(e.error).toBe('single positional indexer is out-of-bounds');
    expect(e.vol_ratio).toBeUndefined();   // the error happened before the volume step
    const d = smcDigest(e);
    expect(d.error).toBe(e.error);
    expect(d.trend).toBe('RANGING');   // the structure step ran before the OB step raised
    expect(d.bull_ob).toBeNull();      // ob is still {} → None in Python
    expect(d.bull_fvg).toBeNull();
    expect(d.vol_ratio).toBeNull();
    expect(d.pd_zone).toEqual({});
  });

  it('smcDigest has the shape of make_golden._smc_digest', () => {
    const a = analyze('TEST-USDT-SWAP', F('htf_sweep_up'), F('mtf_volume'), F('ltf_fvg'), KEY_CFG);
    a.squeeze_score = 0;
    const d = smcDigest(a);
    expect(Object.keys(d)).toEqual([
      'trend', 'bos', 'choch', 'n_swing_highs', 'n_swing_lows', 'last_swing_high', 'last_swing_low', 'equal_highs', 'equal_lows',
      'sweep_up', 'sweep_down', 'bull_ob', 'bear_ob', 'n_fvgs', 'n_ifvgs', 'bull_fvg', 'bear_fvg', 'pd_zone', 'atr', 'vol_ratio', 'vol_avg',
      'current_price', 'current_high', 'current_low', 'squeeze_score', 'error',
    ]);
    expect(d.sweep_up).toEqual({ swept: true, level: 89.025, wick_ratio: 0.6 });
    expect(d.sweep_down).toEqual({ swept: false, level: 0.0, wick_ratio: null });   // no key in the default dict → None
    expect(d.last_swing_high).toBe(101);
    expect(d.equal_lows).toEqual([89.025]);
    expect(Object.keys(d.bull_ob)).toEqual(['found', 'ob_low', 'ob_high', 'ob_mid', 'ob_50_reached', 'type', 'mitigated', 'bar_ago', 'is_breaker', 'impulse_fvg']);
    expect(d.bull_fvg === null || Object.keys(d.bull_fvg).join() === 'type,fvg_low,fvg_high,idx,inversed').toBe(true);
  });
});
