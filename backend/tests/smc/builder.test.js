/**
 * builder.test.js — SMC SIGNAL BUILDER (M4) on hand-built analysis dicts.
 *
 * fixtures/builder_expected.json is what the bot's own Python code
 * (smc/signal_builder.py, liquidity_sl_adjuster.py, smc/scanner._rr_ladder, user_manager.SMCUserCfg)
 * returned for the synthetic analysis dicts of fixtures/gen_builder_expected.py (run with the
 * pinned venv). Every block pins the behaviour in words AND requires equality with Python after the
 * fixture's `.10g` rounding (r10), i.e. the GOLDEN_STRICT rule.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { r10 } from '../../strategies/common/pyfmt.js';
import { pyTruthy, pyOr, pyMax2, pyMin2, pyMinList, pyMaxList, pyFloat } from '../../strategies/common/pyval.js';
import { adjustSlForMagnets, adjustSlForLiquidity } from '../../strategies/common/liquiditySl.js';
import { calculateLevels, isMemcoin, isMajor } from '../../strategies/smc/levels.js';
import { buildSmcSignal, scoreBullish, scoreBearish, checkRetraceWithDepth, computeModeTag, gradeOf, GRADES, LABELS } from '../../strategies/smc/signalBuilder.js';
import { generateNarrative } from '../../strategies/smc/narrative.js';
import { smcConfig, analysisKey } from '../../strategies/smc/config.js';
import smcUserCfg from '../../strategies/smc/smcUserCfg.js';
import smc from '../../strategies/smc/index.js';
import load from '../golden/load.js';

const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
const EXP = JSON.parse(fs.readFileSync(path.join(FIX, 'builder_expected.json'), 'utf8'));
const CASES = Object.fromEntries(EXP.cases.map((c) => [c.name, c]));

const clone = (x) => JSON.parse(JSON.stringify(x));

/** r10 applied recursively (numbers only) — the fixture rounding. */
function r10Deep(x) {
  if (typeof x === 'number') return r10(x);
  if (Array.isArray(x)) return x.map(r10Deep);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, r10Deep(v)]));
  return x;
}

/** Only the keys the Python dict has are compared (the JS levels carry an extra diagnostic liq_info). */
function pickKeys(actual, expected) {
  if (actual === null || expected === null || typeof expected !== 'object' || Array.isArray(expected)) return actual;
  const out = {};
  for (const k of Object.keys(expected)) out[k] = pickKeys(actual[k], expected[k]);
  return out;
}

/** build_smc_signal / calculate_levels / scores of one fixture case, with the config derived like the scanner. */
function runCase(c, { allowedDirs } = {}) {
  const ucfg = smcUserCfg.fromOverrides(c.user_cfg);
  const bc = smcUserCfg.builderConfig(ucfg, { highWrMode: c.high_wr_mode, allowedDirs: allowedDirs || c.kwargs.allowed_dirs });
  const sig = buildSmcSignal(c.symbol, clone(c.analysis), bc.cfg, bc.buildKwargs);
  const record = sig === null ? null : {
    ...sig,
    rr_ladder: smc.rrLadder(sig),
    rr_ladder_text: smc.rrLadderText(sig),
    passes_ctx_gate: smc.passesCtxGate(sig, bc.cfg),
  };
  return { bc, sig, record };
}

describe('common/pyval — CPython truthiness and comparisons', () => {
  const VALUES = { None: null, False: false, True: true, 0: 0, '0.0': 0.0, '-0.0': -0.0, 1: 1, '1e-300': 1e-300, nan: NaN, "''": '', "'a'": 'a', '[]': [], '[0]': [0], '{}': {}, "{'a': None}": { a: null } };
  it('bool(x) table (NaN is truthy, empty dict/list falsy)', () => {
    for (const [repr, want] of EXP.truthy) {
      expect(repr in VALUES).toBe(true);
      expect(pyTruthy(VALUES[repr]), repr).toBe(want);
    }
    expect(pyOr(0, 7)).toBe(7);
    expect(pyOr(NaN, 7)).toBeNaN();
  });
  it('max/min keep the first argument on ties and NaN like Python', () => {
    expect(pyMax2(1, 1)).toBe(1);
    expect(pyMax2(NaN, 1)).toBeNaN();
    expect(pyMax2(1, NaN)).toBe(1);
    expect(pyMin2(2, NaN)).toBe(2);
    expect(pyMinList([3, 1, 2])).toBe(1);
    expect(pyMaxList([3, 1, 2])).toBe(3);
    expect(() => pyMinList([])).toThrow();
    expect(pyFloat('1.5')).toBe(1.5);
    expect(pyFloat(true)).toBe(1);
    expect(() => pyFloat(null)).toThrow();
    expect(() => pyFloat('abc')).toThrow();
  });
});

describe('common/liquiditySl — adjust_sl_for_magnets / _adjust_sl_for_liquidity', () => {
  it('matches Python for every magnet case (zone 0.5 %, buffer 0.1 %, cap 0.6 %, EPS 1e-9)', () => {
    for (const m of EXP.magnets) {
      const [sl, info] = adjustSlForMagnets(m.sl, m.direction, m.prices);
      expect(r10(sl), m.name).toBe(m.new_sl);
      expect(r10Deep(info), m.name).toEqual(m.info);
    }
  });
  it('LONG pushes below the lowest magnet in zone, SHORT above the highest; the SHORT boundary magnet hits the 0.6 % cap', () => {
    const byName = Object.fromEntries(EXP.magnets.map((m) => [m.name, m]));
    expect(byName.long_in_zone.info.n_in_zone).toBe(2);   // 99.4 is outside the 0.5 % zone
    expect(byName.long_in_zone.info.target).toBe(99.6);
    expect(byName.long_in_zone.new_sl).toBe(r10(99.6 * (1 - 0.001)));
    expect(byName.short_in_zone.info.target).toBe(100.45);
    expect(byName.short_boundary.info.capped).toBe(true);
    expect(byName.short_boundary.new_sl).toBe(r10(100.0 * (1 + 0.006)));
    expect(byName.long_none.info.reason).toBe('no_candidates_in_zone');
    expect(byName.zeros.info.reason).toBe('no_magnets');
    expect(byName.invalid_sl.info.reason).toBe('invalid_sl');
    const [, bad] = adjustSlForMagnets(100, 'LONG', [null]);
    expect(bad.reason).toBe('invalid_magnets');
  });
  it('the SMC wrapper reads equal_lows (LONG) / equal_highs (SHORT) cluster prices', () => {
    for (const w of EXP.liq_wrap) {
      const [sl, info] = adjustSlForLiquidity(w.sl, w.direction, w.liq);
      expect(r10(sl), w.name).toBe(w.new_sl);
      expect(r10Deep(info), w.name).toEqual(w.info);
    }
  });
});

describe('levels.calculateLevels — bit-for-bit vs Python for both directions of every case', () => {
  for (const c of EXP.cases) {
    it(c.name, () => {
      const { bc } = runCase(c);
      for (const d of ['LONG', 'SHORT']) {
        const got = calculateLevels(clone(c.analysis), d, bc.cfg);
        const want = c.expected.levels[d];
        if (want === null) expect(got, d).toBeNull();
        else expect(r10Deep(pickKeys(got, want)), d).toEqual(want);
      }
    });
  }
  it('ladder fallback: an invalid structural ladder becomes 1.2 / 2.5 / 4.0 R from entry_mid, rr = 2.5, rr_structural kept', () => {
    const c = CASES.ladder_bad_default;
    const L = c.expected.levels.LONG;
    expect(L.ladder_fallback).toBe(true);
    const risk = L.entry_mid - L.sl;
    expect(r10(L.entry_mid + risk * 1.2)).toBe(L.tp1);
    expect(r10(L.entry_mid + risk * 2.5)).toBe(L.tp2);
    expect(r10(L.entry_mid + risk * 4.0)).toBe(L.tp3);
    expect(L.rr).toBe(2.5);
    expect(L.rr_structural).toBe(1.94);   // the swing high at 101.6, measured BEFORE the fallback
    // and [SMC-LADDER]: 1.94 < MIN_RR 2.0 → no signal although rr (2.5) passes
    expect(c.expected.signal).toBeNull();
    expect(runCase(c).sig).toBeNull();
  });
  it('[SMC-LADDER] the fallback ladder cannot rescue a structural TP2 below MIN_RR (default 2.0 and active 1.5)', () => {
    for (const n of ['ladder_rescue_default', 'ladder_rescue_active']) {
      expect(CASES[n].expected.levels.LONG.rr_structural).toBe(0.97);
      expect(CASES[n].expected.levels.LONG.rr).toBe(2.5);
      expect(runCase(CASES[n]).sig).toBeNull();
    }
  });
  it('a valid structural ladder is kept: TP1 = FVG high, TP2 = swing high, TP3 = nearest equal high above TP2', () => {
    const c = CASES.rich_long_default;
    const L = c.expected.levels.LONG;
    expect(L.ladder_fallback).toBe(false);
    expect(L.tp1).toBe(102.0);
    expect(L.tp2).toBe(104.0);
    expect(L.tp3).toBe(106.0);
    expect(L.rr).toBe(L.rr_structural);
  });
  it('minimum stop by coin class: 0.4 % alt / 0.25 % BTC-ETH / 0.8 % memcoin, then the 1.0×ATR floor', () => {
    expect(isMemcoin('PEPE-USDT-SWAP')).toBe(true);
    expect(isMemcoin('SYN-USDT-SWAP')).toBe(false);
    expect(isMajor('ETHFI-USDT-SWAP')).toBe(true);
    // 0.3 % stop: alt rejected, "ETHFI" counts as a major and passes
    expect(CASES.tight2_alt.expected.levels.LONG).toBeNull();
    expect(runCase(CASES.tight2_alt).sig).toBeNull();
    expect(CASES.tight2_eth.expected.signal.risk_pct).toBeLessThanOrEqual(0.4);   // 3-dp rounded; the raw 0.39985 % is below the alt floor
    expect(runCase(CASES.tight2_eth).sig.direction).toBe('LONG');
    // 0.45 % stop: alt and BTC pass, DOGE (< 0.8 %) is rejected
    expect(runCase(CASES.tight_alt).sig).not.toBeNull();
    expect(runCase(CASES.tight_btc).sig).not.toBeNull();
    expect(CASES.tight_doge.expected.levels.LONG).toBeNull();
    expect(runCase(CASES.tight_doge).sig).toBeNull();
    // ATR floor: risk < 1.0 × ATR → None
    expect(CASES.atr_floor.expected.levels.LONG).toBeNull();
    expect(runCase(CASES.atr_floor).sig).toBeNull();
  });
  it('liquidity magnets widen the SL before the risk is measured (equal low 97.5 within 0.5 % of 97.657)', () => {
    const L = CASES.rich_long_default.expected.levels.LONG;
    expect(L.sl).toBe(r10(97.5 * (1 - 0.001)));
    const got = calculateLevels(clone(CASES.rich_long_default.analysis), 'LONG', smcConfig({ SL_BUFFER_PCT: 0.35 }));
    expect(got.liq_info.adjusted).toBe(true);
    expect(got.liq_info.target).toBe(97.5);
  });
});

describe('signalBuilder — scoring, retrace, mode tag', () => {
  for (const c of EXP.cases) {
    it(`${c.name}: c1..c8 labels/flags and the retrace predicate match Python`, () => {
      const { bc } = runCase(c);
      const sb = scoreBullish(clone(c.analysis), bc.cfg.VOL_MULT);
      const ss = scoreBearish(clone(c.analysis), bc.cfg.VOL_MULT);
      expect([sb.score, sb.confirmations]).toEqual(c.expected.score_long);
      expect([ss.score, ss.confirmations]).toEqual(c.expected.score_short);
      for (const [key, want] of Object.entries(c.expected.retrace)) {
        const [d, depth] = key.split('@');
        expect(checkRetraceWithDepth(clone(c.analysis), d, Number(depth)), key).toBe(want);
      }
      const k = c.kwargs;
      expect(computeModeTag(k.conf_type, k.pd_filter, k.retrace_depth, k.mtf_check)).toBe(c.expected.mode_tag);
    });
  }
  it('mode tag table: ≥ 2 strict filters (BODY_CLOSE, pd, retrace ≥ 0.5, mtf) → Conservative', () => {
    for (const [ct, pdf, rd, mc, want] of EXP.mode_tags) expect(computeModeTag(ct, pdf, rd, mc), `${ct} ${pdf} ${rd} ${mc}`).toBe(want);
    expect(computeModeTag('BODY_CLOSE', false, 0.2, false)).toBe('⚡ Aggressive');   // the bot defaults
  });
  it('c6 label prints vol_mult with Python str(float): 1 → "1.0", 1.2 → "1.2"', () => {
    expect(CASES.rich_long_active.expected.score_long[1][5][0]).toBe('Объём: 1.50× ≥ 1.0× среднего');
    expect(scoreBullish(clone(CASES.rich_long_active.analysis), 1).confirmations[5][0]).toBe('Объём: 1.50× ≥ 1.0× среднего');
    expect(scoreBullish(clone(CASES.rich_long_default.analysis), 1.2).confirmations[5][0]).toBe('Объём: 1.50× ≥ 1.2× среднего');
    expect(LABELS.LONG.c1).toBe('HTF структура: бычья / CHoCH вверх');
    expect(LABELS.SHORT.c5).toBe('Premium Zone: цена в верхних 50%');
  });
  it('c7 always uses depth 0.5 (ob_50_reached) while F4 uses the user depth; depth 0.5 is an exact compare', () => {
    const a = clone(CASES.tie_default.analysis);
    a.ob.bull_ob.ob_50_reached = false;
    a.ob.bull_ob.mitigated = true;
    a.fvg.bull_fvg = null;
    a.ob.bull_ob.impulse_fvg = null;
    a.current_low = 98.9;
    expect(checkRetraceWithDepth(a, 'LONG', 0.5)).toBe(false);
    expect(checkRetraceWithDepth(a, 'LONG', 0.0)).toBe(true);
    expect(checkRetraceWithDepth(a, 'LONG', 0.5000001)).toBe(true);   // "other depth" branch: current_low 98.9 <= 100 - d*(100-98)
    expect(checkRetraceWithDepth(a, 'LONG', 0.2)).toBe(true);         // target 99.6, current_low 98.9 <= 99.6
    expect(scoreBullish(a, 1.2).confirmations[6][1]).toBe(false);
  });
  it('grades: 5 → 🔥 A+, 4 → ✅ A, 3 → ⚡ B, else "⚡ N/5"', () => {
    expect(GRADES[5]).toBe('🔥 A+');
    expect(gradeOf(4)).toBe('✅ A');
    expect(gradeOf(3)).toBe('⚡ B');
    expect(gradeOf(2)).toBe('⚡ 2/5');
    expect(gradeOf(0)).toBe('⚡ 0/5');
  });
});

describe('signalBuilder.buildSmcSignal — every case equals the Python SMCSignalResult (+ rr_ladder, ctx gate)', () => {
  for (const c of EXP.cases) {
    it(c.name, () => {
      const { record } = runCase(c);
      const want = c.expected.signal;
      if (want === null) expect(record).toBeNull();
      else expect(r10Deep(record)).toEqual(want);
    });
  }
  it('direction gating: LONG wins ties; allowed_dirs narrows; an empty tuple yields no signal', () => {
    expect(CASES.tie_default.expected.score_long[0]).toBe(CASES.tie_default.expected.score_short[0]);
    expect(runCase(CASES.tie_default).sig.direction).toBe('LONG');
    expect(runCase(CASES.tie_short_only).sig.direction).toBe('SHORT');
    expect(runCase(CASES.tie_long_only).sig.direction).toBe('LONG');
    expect(runCase(CASES.tie_none).sig).toBeNull();
    expect(runCase(CASES.tie_default, { allowedDirs: ['SHORT'] }).sig.direction).toBe('SHORT');
  });
  it('F1 wick-sweep guard only in BODY_CLOSE mode', () => {
    expect(runCase(CASES.wick_sweep_body_close).sig).toBeNull();
    expect(runCase(CASES.wick_sweep_wick_touch).sig.direction).toBe('LONG');
  });
  it('F2 MTF / F3 P-D / F5 hard volume block only when enabled (conservative), not in the default variant', () => {
    expect(runCase(CASES.mtf_block_cons).sig).toBeNull();
    expect(runCase(CASES.mtf_block_default).sig.direction).toBe('LONG');
    expect(runCase(CASES.pd_block_cons).sig).toBeNull();
    expect(runCase(CASES.pd_block_default).sig.direction).toBe('LONG');
    expect(runCase(CASES.vol_filter_cons).sig).toBeNull();
    expect(runCase(CASES.vol_filter_default).sig.direction).toBe('LONG');
    // a SHORT with vol_ratio 0.9 passes every conservative gate except F5
    expect(runCase(CASES.rich_short_conservative).sig).toBeNull();
    expect(runCase(CASES.rich_short_default).sig.score).toBe(5);
  });
  it('analysis.error → null; memcoin caps the score at 3 (⚡ B) after the 5-cap', () => {
    expect(runCase(CASES.analysis_error).sig).toBeNull();
    const pepe = runCase(CASES.rich_long_pepe).sig;
    expect(CASES.rich_long_pepe.expected.score_long[0]).toBe(8);
    expect(pepe.score).toBe(3);
    expect(pepe.grade).toBe('⚡ B');
    expect(runCase(CASES.rich_long_default).sig.score).toBe(5);
  });
  it('HWR mode: MIN_CONFIRMATIONS forced to ≥ 4, P/D and MTF forced on, analysis key untouched, tag Conservative', () => {
    const c = CASES.hwr_active_cfg;
    const { bc, sig } = runCase(c);
    expect(bc.cfg.MIN_CONFIRMATIONS).toBe(4);
    expect(bc.buildKwargs.pd_filter).toBe(true);
    expect(bc.buildKwargs.mtf_check).toBe(true);
    expect(bc.buildKwargs.conf_type).toBe('WICK_TOUCH');
    expect(bc.analysisKey).toEqual([true, true, true, 50, false, 20]);
    expect(sig.mode_tag).toBe('🎯 Conservative');
    expect(sig.score).toBe(5);
    expect(smc.passesCtxGate({ score: 3 }, bc.cfg)).toBe(false);
    expect(smc.passesCtxGate({ score: 4 }, bc.cfg)).toBe(true);
    const plain = smcUserCfg.builderConfig(smcUserCfg.fromOverrides(c.user_cfg), { highWrMode: false });
    expect(plain.cfg.MIN_CONFIRMATIONS).toBe(2);
    expect(plain.buildKwargs.pd_filter).toBe(false);
  });
  it('rr_ladder = R to TP1/TP2/TP3 (2 dp) and its card text', () => {
    const s = CASES.rich_long_default.expected.signal;
    expect(s.rr_ladder).toEqual([1.88, 3.13, 4.38]);
    expect(s.rr_ladder_text).toBe('1:1.88 / 1:3.13 / 1:4.38');
    expect(smc.rrLadder({ entry: 100, sl: 100, tp1: 101, tp2: 102, tp3: 103 })).toEqual([0.0, 0.0, 0.0]);
    expect(smc.rrLadderText({ entry: 100, sl: 99, tp1: 101, tp2: 102.5, tp3: 104 })).toBe('1:1 / 1:2.5 / 1:4');
  });
});

describe('narrative — verbatim Russian text', () => {
  it('breaker wording (inverted role quirk), CHoCH UP sentence, BOS sentence from the sweep level, no-FVG TP1 wording', () => {
    const c = CASES.breaker_default;
    const { bc } = runCase(c);
    const lv = calculateLevels(clone(c.analysis), 'LONG', bc.cfg);
    const text = generateNarrative(clone(c.analysis), lv, 'LONG', { ...bc.buildKwargs, cfg: bc.cfg });
    expect(text).toBe(c.expected.signal.narrative);
    expect(text).toContain('Бывший медвежий OB пробит и стал Breaker Block\'ом 98–100.0 — теперь работает как медвежий уровень.');
    expect(text).toContain('Пробой структуры (BOS) на уровне 103.3 подтвердил намерение рынка.');
    expect(text).toContain('Первая цель — структурный уровень (101.0)');
  });
  it('price formatting through _fp for small and large prices; CHoCH DOWN; inversed FVG; show_invalidation=false', () => {
    expect(CASES.small_price.expected.signal.narrative).toContain('ордер-блок 0.00006443–0.00006575 на 1H');
    expect(CASES.big_price.expected.signal.narrative).toContain('ордер-блок 63,700–65,000 на 1H');   // ≥ 10 000 → no decimals
    expect(CASES.big_price.expected.signal.narrative).toContain('на уровне 63,312 —');
    expect(CASES.breaker_default.expected.signal.narrative).toContain('Breaker Block\'ом 98–100.0');     // ≥ 100 → one decimal, ≥ 1 → stripped
    expect(CASES.choch_down_default.expected.signal.narrative).toMatch(/^На 4H зафиксирована смена характера движения вниз \(CHoCH\) на уровне 99\.9\. /);
    expect(CASES.rich_short_default.expected.signal.narrative).toContain('Перевёрнутый FVG 98–98.5 выступает как усиленный уровень сопротивления после смены роли.');
    const c = CASES.rich_long_default;
    const { bc } = runCase(c);
    const lv = calculateLevels(clone(c.analysis), 'LONG', bc.cfg);
    const noInv = generateNarrative(clone(c.analysis), lv, 'LONG', { ...bc.buildKwargs, cfg: bc.cfg, show_invalidation: false });
    expect(c.expected.signal.narrative.startsWith(noInv + ' Сетап теряет силу')).toBe(true);
    const noCfg = generateNarrative(clone(c.analysis), lv, 'LONG', { ...bc.buildKwargs, cfg: null });
    expect(noCfg).toContain('с буфером 0.15% на уровне');
  });
});

describe('smcUserCfg — SMCUserCfg defaults / from_json and the scanner derivation', () => {
  it('defaults equal the dataclass; from_json keeps known keys only and falls back on any error', () => {
    expect(smcUserCfg.defaults()).toEqual(CASES.rich_long_default.expected.ucfg);
    expect(smcUserCfg.fromJson('{"min_rr": 2.5, "bogus": 1}').min_rr).toBe(2.5);
    expect('bogus' in smcUserCfg.fromJson('{"bogus": 1}')).toBe(false);
    expect(smcUserCfg.fromJson('not json')).toEqual(smcUserCfg.defaults());
    expect(smcUserCfg.fromJson('[1,2]')).toEqual(smcUserCfg.defaults());
    expect(smcUserCfg.fromJson('')).toEqual(smcUserCfg.defaults());
    expect(smcUserCfg.fromJson(null)).toEqual(smcUserCfg.defaults());
  });
  for (const c of EXP.cases) {
    it(`${c.name}: cfg_obj / analysis key / build kwargs / asdict(ucfg) derived like smc/scanner`, () => {
      const ucfg = smcUserCfg.fromOverrides(c.user_cfg);
      expect(ucfg).toEqual(c.expected.ucfg);
      const bc = smcUserCfg.builderConfig(ucfg, { highWrMode: c.high_wr_mode, allowedDirs: c.kwargs.allowed_dirs });
      expect(bc.cfg).toEqual(c.expected.cfg);
      expect(bc.analysisKey).toEqual(c.expected.analysis_key);
      expect(bc.buildKwargs).toEqual(c.kwargs);
      expect(analysisKey(bc.cfg)).toEqual(c.expected.analysis_key);
    });
  }
  it('the three golden variants derive exactly the recorded cfg_obj / analysis_key / build_kwargs', () => {
    const variants = load.loadExpected('smc').variants;
    for (const [name, v] of Object.entries(variants)) {
      const bc = smcUserCfg.builderConfig(smcUserCfg.fromOverrides(v.smc_user_cfg), { highWrMode: v.high_wr_mode });
      expect(bc.cfg, name).toEqual(v.smc_config);
      expect(bc.analysisKey, name).toEqual(v.analysis_key);
      expect(bc.buildKwargs, name).toEqual(v.build_kwargs);
    }
    expect(variants.conservative.smc_config.MIN_CONFIRMATIONS).toBe(4);
    expect(variants.active.analysis_key).toEqual([true, true, true, 50, false, 20]);
  });
  it('TF groups and [SMC-DIR] allowed directions', () => {
    expect(smcUserCfg.tfGroup('1H')).toEqual(['4H', '1H', '15m']);
    expect(smcUserCfg.tfGroup('15m')).toEqual(['1H', '15m', '15m']);
    expect(smcUserCfg.tfGroup('4H')).toEqual(['1D', '4H', '1H']);
    expect(smcUserCfg.tfGroup('weird')).toEqual(['4H', '1H', '15m']);
    const u = smcUserCfg.defaults();
    expect(smcUserCfg.allowedDirs(u)).toEqual(['LONG', 'SHORT']);
    expect(smcUserCfg.allowedDirs({ ...u, direction: 'SHORT' })).toEqual(['SHORT']);
    expect(smcUserCfg.allowedDirs(u, false, true)).toEqual(['SHORT']);
    expect(smcUserCfg.allowedDirs({ ...u, direction: 'LONG' }, false, true)).toEqual([]);
    expect(smcUserCfg.allowedDirs({ ...u, direction: 'LONG' }, true, true)).toEqual(['LONG']);
    const bc = smcUserCfg.builderConfig({ ...u, tf_key: '15m', direction: 'SHORT' });
    expect(bc.buildKwargs.tf_ltf).toBe('15m');
    expect(bc.buildKwargs.allowed_dirs).toEqual(['SHORT']);
    expect(smcUserCfg.RANGES.smc_vol_mult.max).toBe(5.0);
  });
});

describe('index.evaluate — the pure per-(symbol, user) path on golden frames', () => {
  it('reproduces a recorded default-variant signal of SYNRG01 end to end', () => {
    const expected = load.loadExpected('smc');
    const fx = expected.fixtures['SYNRG01-USDT-SWAP'].default;
    const rec = fx.signals[0];
    const frames = load.loadFrames('SYNRG01-USDT-SWAP');
    const b = load.barInputs(frames, rec.i);
    const out = smc.evaluate({ symbol: 'SYNRG01-USDT-SWAP', dfHtf: b.dfHtf4h, dfMtf: b.df, dfLtf: b.dfLtf15m, ucfg: smcUserCfg.defaults() });
    expect(out.analysisKey).toEqual(expected.variants.default.analysis_key);
    expect(out.signal.direction).toBe(rec.direction);
    expect(r10(out.signal.entry)).toBe(rec.entry);
    expect(out.signal.narrative).toBe(rec.narrative);
    expect(out.signal.rr_ladder).toEqual(rec.rr_ladder);
    expect(out.signal.passes_ctx_gate).toBe(rec.passes_ctx_gate);
    expect(out.signal.squeeze_score).toBe(rec.squeeze_score);
    expect(smc.smcDigest(out.analysis).trend).toBe(load.loadExpected('smc_analysis').fixtures['SYNRG01-USDT-SWAP'][String(rec.i)].trend);
  });
});
