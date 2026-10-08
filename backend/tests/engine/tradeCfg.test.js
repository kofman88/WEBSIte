/**
 * tradeCfg.js — the bot's TradeCfg / shared-vs-LONG/SHORT model.
 *
 * Reference values printed by the bot (CHM_BREAKER_V4, python 3.12, venv):
 *   user_manager._sparse_merge / handlers._common._update_long_field /
 *   UserSettings.get_long_cfg — see the A…L vectors inline.
 */
import { describe, it, expect } from 'vitest';
import tc from '../../services/engine/tradeCfg.js';
import { pyJsonDumps, pyJsonLoads } from '../../services/engine/pyjson.js';
import { pyInt, pyFloat, pyBool, isClose, PyValueError, PyTypeError } from '../../services/engine/pycoerce.js';

const user = (o = {}) => ({
  ...Object.fromEntries(tc.FIELDS.map((f) => [f[0], f[2]])),
  long_tf: '1h', long_interval: 3600, short_tf: '1h', short_interval: 3600,
  long_cfg: '{}', short_cfg: '{}', ...o,
});

// TradeCfg().to_json() from the bot (default int literal 300_000 prints as "300000" there;
// the site stores the float-typed field as a Python float → "300000.0").
const DEFAULT_JSON = '{"timeframe": "1h", "scan_interval": 300, "pivot_strength": 7, "max_level_age": 100, "max_retest_bars": 30, "zone_buffer": 0.3, "ema_fast": 50, "ema_slow": 200, "htf_ema_period": 50, "rsi_period": 14, "rsi_ob": 65, "rsi_os": 35, "vol_mult": 1.0, "vol_len": 20, "use_rsi": true, "use_volume": true, "use_pattern": false, "use_htf": false, "atr_period": 14, "atr_mult": 1.0, "max_risk_pct": 1.5, "tp1_rr": 2.0, "tp2_rr": 3.0, "tp3_rr": 4.5, "min_volume_usdt": 300000.0, "min_quality": 3, "cooldown_bars": 5, "trend_only": false, "zone_pct": 0.7, "max_dist_pct": 1.5, "min_rr": 2.0, "max_level_tests": 4}';

describe('TradeCfg defaults and __post_init__ clamp order', () => {
  it('32 fields in dataclass order with the dataclass defaults', () => {
    expect(tc.FIELD_NAMES.length).toBe(32);
    expect(tc.FIELD_NAMES[0]).toBe('timeframe');
    expect(tc.FIELD_NAMES[31]).toBe('max_level_tests');
    expect(tc.DEFAULTS).toMatchObject({ scan_interval: 300, min_volume_usdt: 300000, min_quality: 3, tp3_rr: 4.5, min_rr: 2.0 });
    expect(tc.toJson(tc.tradeCfg())).toBe(DEFAULT_JSON);
  });
  it('min_rr < 1 → 1; tp ladder re-ordered from min_rr; scan_interval 60..86400; min_quality 0..10; vol_mult 0.1..5', () => {
    // bot vector G: sparse {"tp1_rr":0.5,"tp2_rr":0.4,"tp3_rr":0.3,"scan_interval":10,"min_quality":99,"vol_mult":9,"max_risk_pct":0.01,"cooldown_bars":-3}
    const c = tc.tradeCfg({ min_rr: 2.5, tp1_rr: 0.5, tp2_rr: 0.4, tp3_rr: 0.3, scan_interval: 10, min_quality: 99, vol_mult: 9, max_risk_pct: 0.01, cooldown_bars: -3 });
    expect(c).toMatchObject({ min_rr: 2.5, tp1_rr: 2.5, tp2_rr: 3.5, tp3_rr: 5.0, scan_interval: 60, min_quality: 10, vol_mult: 5.0, max_risk_pct: 0.1, cooldown_bars: 0 });
    expect(tc.tradeCfg({ scan_interval: 99999 }).scan_interval).toBe(86400);
    expect(tc.tradeCfg({ max_risk_pct: 9 }).max_risk_pct).toBe(5.0);
    expect(tc.tradeCfg({ min_quality: -4 }).min_quality).toBe(0);
    expect(tc.tradeCfg({ vol_mult: 0 }).vol_mult).toBe(0.1);
  });
  it('tp1 < min_rr → min_rr, tp2 ≤ tp1 → tp1 + 1, tp3 ≤ tp2 → tp2 + 1.5 (bot vector B)', () => {
    const c = tc.tradeCfg({ pivot_strength: 5, min_rr: 3.0 });
    expect([c.tp1_rr, c.tp2_rr, c.tp3_rr]).toEqual([3.0, 4.0, 4.5]);
  });
  it('unknown keys are ignored; fromJson tolerates garbage', () => {
    expect(tc.tradeCfg({ bogus: 1 })).not.toHaveProperty('bogus');
    expect(tc.fromJson('not json')).toEqual(tc.tradeCfg());
    expect(tc.fromJson('[1,2]')).toEqual(tc.tradeCfg());
    expect(tc.fromJson('{"pivot_strength": 5, "x": 1}').pivot_strength).toBe(5);
  });
});

describe('_sparse_merge (legacy full dump vs sparse)', () => {
  it('A: sparse {"min_rr": 0.8} merges then clamps to 1.0 (stored 0.8 reads back as 1.0)', () => {
    const m = tc.sparseMerge(tc.sharedCfg(user()), '{"min_rr": 0.8, "_sparse": true}');
    expect(m.min_rr).toBe(1.0);
    expect(m.pivot_strength).toBe(7);
  });
  it('B: legacy full dump keeps only the values that differ from TradeCfg() defaults', () => {
    const legacy = tc.toJson(tc.tradeCfg({ pivot_strength: 5, min_rr: 3.0 }));   // tp ladder already clamped in the dump
    const m = tc.sparseMerge(tc.sharedCfg(user()), legacy);
    expect(m).toMatchObject({ pivot_strength: 5, min_rr: 3.0, tp1_rr: 3.0, tp2_rr: 4.0, tp3_rr: 4.5 });
  });
  it('C: a legacy dump equal to the defaults overrides nothing — the shared cfg wins', () => {
    const base = user({ pivot_strength: 10, min_rr: 2.5, tp1_rr: 1.0 });
    const m = tc.sparseMerge(tc.sharedCfg(base), tc.toJson(tc.tradeCfg()));
    expect(m).toMatchObject({ pivot_strength: 10, min_rr: 2.5, tp1_rr: 2.5, tp2_rr: 3.0, tp3_rr: 4.5 });
  });
  it('D: a sparse dump overrides even with default-equal / uncoerced values', () => {
    const base = user({ pivot_strength: 10, min_rr: 2.5, tp1_rr: 1.0 });
    const m = tc.sparseMerge(tc.sharedCfg(base), '{"pivot_strength": 7, "use_rsi": 1, "_sparse": true}');
    expect(m.pivot_strength).toBe(7);
    expect(m.use_rsi).toBe(1);          // not coerced, like the bot
  });
  it('E: the same dump without _sparse is legacy: default-equal values are dropped', () => {
    const base = user({ pivot_strength: 10, min_rr: 2.5, tp1_rr: 1.0 });
    const m = tc.sparseMerge(tc.sharedCfg(base), '{"pivot_strength": 7, "use_rsi": 1}');
    expect(m.pivot_strength).toBe(10);
    expect(m.use_rsi).toBe(true);
  });
  it('F: invalid JSON → no overrides', () => {
    const base = user({ pivot_strength: 10 });
    expect(tc.sparseMerge(tc.sharedCfg(base), 'not json').pivot_strength).toBe(10);
    expect(tc.sparseMerge(tc.sharedCfg(base), '').pivot_strength).toBe(10);
    expect(tc.sparseMerge(tc.sharedCfg(base), null).pivot_strength).toBe(10);
  });
  it('H: legacy float comparison uses math.isclose(rel 1e-6, abs 1e-9); 3.0 == 3', () => {
    const base = user({ pivot_strength: 10 });
    const m = tc.sparseMerge(tc.sharedCfg(base), '{"vol_mult": 1.0000001, "zone_buffer": 0.3000000001, "min_quality": 3.0}');
    expect(m.vol_mult).toBe(1.0);
    expect(m.zone_buffer).toBe(0.3);
    expect(m.min_quality).toBe(3);
    expect(tc.valEq(1.0000001, 1.0, 'float')).toBe(true);
    expect(tc.valEq(1.001, 1.0, 'float')).toBe(false);
    expect(tc.valEq(1, true, 'bool')).toBe(true);
    expect(tc.valEq('7', 7, 'int')).toBe(false);
    expect(tc.valEq(7.0, 7, 'int')).toBe(true);
  });
  it('QUIRK: min_volume_usdt default is the int literal 300_000 — legacy values near it are compared exactly, not with isclose', () => {
    // bot: _val_eq(300000.15, 300000) → not both floats → 300000.15 == 300000 → False → kept
    expect(tc.loadSparse('{"min_volume_usdt": 300000.15}')).toEqual({ min_volume_usdt: 300000.15 });
    expect(tc.loadSparse('{"min_volume_usdt": 300000.0000000001}')).toEqual({ min_volume_usdt: 300000.0000000001 });
    expect(tc.loadSparse('{"min_volume_usdt": 300000.0}')).toEqual({});
    expect(tc.loadSparse('{"min_volume_usdt": 300000}')).toEqual({});
    // a float-literal default keeps the isclose branch (zone_pct 0.7 vs 0.7000000001)
    expect(tc.loadSparse('{"zone_pct": 0.7000000001}')).toEqual({});
    const base = tc.tradeCfg({ min_volume_usdt: 1000000 });
    expect(tc.sparseMerge(base, '{"min_volume_usdt": 300000.15}').min_volume_usdt).toBe(300000.15);
    expect(tc.sparseMerge(base, '{"min_volume_usdt": 300000.0}').min_volume_usdt).toBe(1000000);
  });

  it('loadSparse keeps only TradeCfg keys and drops "_sparse"', () => {
    expect(tc.loadSparse('{"pivot_strength": 5, "foo": 1, "_sparse": true}')).toEqual({ pivot_strength: 5 });
    expect(tc.loadSparse('{"pivot_strength": 7, "min_rr": 2.5}')).toEqual({ min_rr: 2.5 });
    expect(tc.loadSparse('[1]')).toEqual({});
  });
});

describe('_update_long_field / _update_short_field / _save_sparse', () => {
  it('I, J: explicit overrides accumulate in the sparse JSON with the _sparse flag', () => {
    const u = user();
    tc.updateLongField(u, 'pivot_strength', 5);
    expect(u.long_cfg).toBe('{"pivot_strength": 5, "_sparse": true}');
    tc.updateLongField(u, 'zone_buffer', 0.5);
    expect(u.long_cfg).toBe('{"pivot_strength": 5, "zone_buffer": 0.5, "_sparse": true}');
    tc.updateShortField(u, 'min_rr', 2.5);
    expect(u.short_cfg).toBe('{"min_rr": 2.5, "_sparse": true}');
    expect(u.long_cfg).toBe('{"pivot_strength": 5, "zone_buffer": 0.5, "_sparse": true}');
  });
  it('K: a legacy full-dump long_cfg is normalised on the first write', () => {
    const u = user();
    u.long_cfg = tc.toJson(tc.tradeCfg({ pivot_strength: 5 }));
    tc.updateLongField(u, 'min_rr', 2.5);
    expect(u.long_cfg).toBe('{"pivot_strength": 5, "min_rr": 2.5, "_sparse": true}');
  });
  it('L: get_long_cfg = sparse merge + timeframe / scan_interval from long_tf / long_interval', () => {
    const u = user({ long_tf: '4h', long_interval: 900, short_tf: '15m', short_interval: 60 });
    u.long_cfg = '{"pivot_strength": 5, "min_rr": 2.5, "_sparse": true}';
    const lc = tc.getLongCfg(u);
    expect(lc).toMatchObject({ timeframe: '4h', scan_interval: 900, pivot_strength: 5, min_rr: 2.5, tp1_rr: 2.5 });
    const sc = tc.getShortCfg(u);
    expect(sc).toMatchObject({ timeframe: '15m', scan_interval: 60, pivot_strength: 7, min_rr: 2.0 });
    expect(tc.overrideKeys(u.long_cfg)).toEqual(['pivot_strength', 'min_rr']);
  });
  it('float-typed values print as Python floats, ints as ints', () => {
    const u = user();
    tc.updateLongField(u, 'tp1_rr', 2);
    tc.updateLongField(u, 'max_level_tests', 99);
    expect(u.long_cfg).toBe('{"tp1_rr": 2.0, "max_level_tests": 99, "_sparse": true}');
    expect(tc.saveSparse({ foo: 1, zone_pct: 1.35 })).toBe('{"zone_pct": 1.35, "_sparse": true}');
  });
});

describe('shared field helpers', () => {
  it('updateSharedField only touches existing attributes; long/short JSON untouched', () => {
    const u = user({ long_cfg: '{"min_rr": 2.5, "_sparse": true}' });
    tc.updateSharedField(u, 'min_quality', 7);
    tc.updateSharedField(u, 'nope', 1);
    expect(u.min_quality).toBe(7);
    expect(u).not.toHaveProperty('nope');
    expect(u.long_cfg).toBe('{"min_rr": 2.5, "_sparse": true}');
    expect(tc.sharedCfg(u).min_quality).toBe(7);
  });
  it('applySharedCfg copies every TradeCfg field onto the flat columns', () => {
    const u = user({ long_cfg: '{"min_rr": 2.5, "_sparse": true}' });
    tc.applySharedCfg(u, tc.tradeCfg({ pivot_strength: 15, ema_fast: 20 }));
    expect(u.pivot_strength).toBe(15);
    expect(u.ema_fast).toBe(20);
    expect(u.long_cfg).toBe('{"min_rr": 2.5, "_sparse": true}');
  });
  it('sharedCfg clamps (stored min_rr 0.8 reads 1.0) — QUIRK data-and-market §2.1', () => {
    expect(tc.sharedCfg(user({ min_rr: 0.8 })).min_rr).toBe(1.0);
  });
  it('cfgToInd: IndConfig keys, MIN_RR floor 1.8, HTF 1d fixed, high_wr passthrough', () => {
    const ind = tc.cfgToInd(tc.tradeCfg({ min_rr: 1.0 }), { highWrMode: true });
    expect(ind.MIN_RR).toBe(1.8);
    expect(ind.HIGH_WR_MODE).toBe(true);
    expect(ind.USE_RSI_FILTER).toBe(true);
    expect(ind.TP3_RR).toBe(4.5);
    expect(tc.cfgToInd(tc.tradeCfg({ min_rr: 3 })).MIN_RR).toBe(3);
    expect(tc.cfgToInd(tc.tradeCfg(), { levelsMinRr: 2.5 }).MIN_RR).toBe(2.5);
    expect(Object.keys(ind).length).toBe(29);
  });
});

describe('pyjson / pycoerce', () => {
  it('json.dumps spacing, ensure_ascii, float keys', () => {
    expect(pyJsonDumps({ a: 'Привет "x"\n', b: [1, 2.5, true, null], c: { d: 1e-5, e: 1e16 } }))
      .toBe('{"a": "\\u041f\\u0440\\u0438\\u0432\\u0435\\u0442 \\"x\\"\\n", "b": [1, 2.5, true, null], "c": {"d": 1e-05, "e": 10000000000000000}}');
    expect(pyJsonDumps({ x: 300000, y: 300000 }, ['x'])).toBe('{"x": 300000.0, "y": 300000}');
    expect(pyJsonDumps({ market_regime: true, news_monitor: true, genome_engine: false }))
      .toBe('{"market_regime": true, "news_monitor": true, "genome_engine": false}');
    expect(pyJsonLoads('bad', { d: 1 })).toEqual({ d: 1 });
    expect(pyJsonLoads('{"a":1}')).toEqual({ a: 1 });
  });
  it('int() / float() / bool() semantics', () => {
    expect(pyInt('7')).toBe(7);
    expect(pyInt(3.7)).toBe(3);
    expect(pyInt(true)).toBe(1);
    expect(() => pyInt('1.5')).toThrow(PyValueError);
    expect(() => pyInt(null)).toThrow(PyTypeError);
    expect(() => pyInt(NaN)).toThrow(PyValueError);
    expect(pyFloat(' 2.5 ')).toBe(2.5);
    expect(pyFloat('inf')).toBe(Infinity);
    expect(Number.isNaN(pyFloat('nan'))).toBe(true);
    expect(() => pyFloat('abc')).toThrow(PyValueError);
    expect(() => pyFloat([1])).toThrow(PyTypeError);
    expect(pyBool('false')).toBe(true);
    expect(pyBool('')).toBe(false);
    expect(pyBool(0)).toBe(false);
    expect(pyBool([])).toBe(false);
    expect(pyBool({ a: 1 })).toBe(true);
    expect(isClose(1.0000001, 1.0, 1e-6, 1e-9)).toBe(true);
    expect(isClose(0, 1e-10, 1e-6, 1e-9)).toBe(true);
    expect(isClose(1, 1.01, 1e-6, 1e-9)).toBe(false);
  });
});
