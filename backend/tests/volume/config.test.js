/**
 * VolumeConfig — from_params coercion (CPython bool/int/float/str rules), the 25 `_fix`
 * steps in order, dataclass helpers. Expected values: pins.json (the bot's own
 * VolumeConfig.from_params on the same inputs) plus the spec §3.1 worked example.
 */
import { describe, it, expect } from 'vitest';
import C from '../../strategies/volume/config.js';
import P from './pins.js';

const { VolumeConfig, minBars, DEFAULTS, FIELD_NAMES, USER_PREF_KEYS, CONFIG_FIELDS, pyInt, pyFloat, pyBool, PyValueError, PyOverflowError } = C;
const { pins, pinNum } = P;

/** The inputs of pins.config (same literals as volume_verify2.py; None → null, True → true). */
const CASES = {
  spec_example: { ma_fast: 30, ma_mid: 20, tp1_rr: 0.5, tp2_rr: 0.7, climax_mult: 1.0, ma_type: 'EMA', setup_cross: 'off', vol_len: '7', rsi_long_max: 'abc' },
  variants_conservative: { min_quality: 4, vol_mult: 2.0, trend_filter: true, use_htf: true, bounce_vol_mult: 1.2 },
  variants_active: { min_quality: 2, ma_type: 'ema', ma_fast: 9, ma_mid: 21, trend_filter: false, use_htf: false, vol_mult: 1.2, setup_ribbon: true },
  coercion_mix: {
    ma_fast: 1.9, ma_mid: '  21 ', ma_slow: '1_00', vol_mult: '2_5', use_htf: 'YES', setup_turn: 0, setup_bounce: 'maybe', setup_golden: 2,
    turn_period: '7.0', atr_period: '0x10', sl_atr_mult: ' .5', max_sl_pct: '1e1', min_quality: '9', ma_type: 5, unknown_key: 1, to_dict: 1,
    ema_mid: null, cross_lookback: -3, turn_slope_bars: 99, extension_atr: 'inf', rsi_period: true, tp3_rr: '', bounce_tol_atr: [1], htf_ema: false,
  },
  empty: {},
  fix_cascade: {
    ma_fast: 100, ema_mid: 1, ema_trend: 10, ma_slow: 300, climax_mult: 0.1, vol_mult: 0.1, tp1_rr: 3.0, tp2_rr: 1.0, tp3_rr: 1.0, vol_len: 1,
    bounce_vol_mult: 0.0, swing_lookback: 0, turn_lookback: 0, turn_period: 1, htf_ema: 2, sl_buffer_atr: -1, turn_min_slope_atr: -0.1,
    extension_atr: 0.1, min_quality: 0,
  },
  tp_round: { tp1_rr: 1.1, tp2_rr: 1.05 },
};

function expectConfig(cfg, pin) {
  const got = cfg.toDict();
  expect(Object.keys(got)).toEqual(pins.config.__field_order);
  for (const k of FIELD_NAMES) {
    const want = pinNum(pin[k]);
    if (!Object.is(got[k], want)) throw new Error(`${k}: got ${got[k]} want ${want}`);
  }
  expect(minBars(cfg)).toBe(pin.__min_bars);
  expect(cfg.setupsEnabled()).toEqual(pin.__setups);
  expect(cfg.maPrefix()).toBe(pin.__prefix);
}

describe('VolumeConfig.fromParams (coercion + _fix) vs the bot', () => {
  for (const name of Object.keys(CASES)) {
    it(name, () => expectConfig(VolumeConfig.fromParams(CASES[name]), pins.config[name]));
  }

  it('spec §3.1 worked example (explicit)', () => {
    const cfg = VolumeConfig.fromParams(CASES.spec_example);
    expect([cfg.ma_fast, cfg.ma_mid, cfg.ma_slow, cfg.ema_trend]).toEqual([30, 60, 120, 200]);
    expect([cfg.climax_mult, cfg.tp1_rr, cfg.tp2_rr, cfg.tp3_rr]).toEqual([3.5, 1.0, 1.5, 3.0]);
    expect(cfg.ma_type).toBe('ema');
    expect(cfg.setup_cross).toBe(false);
    expect(cfg.vol_len).toBe(7);
    expect(cfg.rsi_long_max).toBe(70.0);     // "abc" → ValueError → skipped
    expect(minBars(cfg)).toBe(215);          // max(200,120,20) + max(7,10,10,9) + 5
  });

  it('int(inf) raises OverflowError which from_params does NOT catch', () => {
    expect(pins.config.int_inf).toMatch(/^OverflowError/);
    expect(() => VolumeConfig.fromParams({ ma_fast: Infinity })).toThrow(PyOverflowError);
  });

  it('null / empty params → the defaults; None values and unknown keys are ignored', () => {
    expect(VolumeConfig.fromParams(null).toDict()).toEqual(DEFAULTS);
    expect(VolumeConfig.fromParams({}).toDict()).toEqual(DEFAULTS);
    expect(VolumeConfig.fromParams({ ma_fast: null, nope: 3, toDict: 1 }).toDict()).toEqual(DEFAULTS);
  });

  it('field order, CONFIG_FIELDS (38 dataclass fields) and paramsDict (minus the six user preferences)', () => {
    expect(FIELD_NAMES).toEqual(pins.config.__field_order);
    expect(CONFIG_FIELDS.size).toBe(pins.config.__field_order.length);
    expect(CONFIG_FIELDS.size).toBe(38);
    expect(Object.keys(new VolumeConfig().paramsDict())).toEqual(pins.config.__params_dict_keys);
    expect(USER_PREF_KEYS).toEqual(['setup_cross', 'setup_turn', 'setup_bounce', 'setup_golden', 'setup_ribbon', 'use_htf']);
  });

  it('constructor and replace() set fields verbatim without _fix (dataclass semantics)', () => {
    const cfg = new VolumeConfig({ ma_mid: 5 });
    expect(cfg.ma_mid).toBe(5);
    expect(cfg.ma_fast).toBe(10);
    const pre = cfg.replace({ use_htf: false, min_quality: 2 });
    expect(pre.use_htf).toBe(false);
    expect(pre.min_quality).toBe(2);
    expect(pre.ma_mid).toBe(5);              // still unfixed
    expect(cfg.use_htf).toBe(true);          // the original is untouched
    expect(() => new VolumeConfig({ bogus: 1 })).toThrow(TypeError);
    expect(() => cfg.replace({ bogus: 1 })).toThrow(TypeError);
    const f = cfg.replace({});
    f.fix();
    expect(f.ma_mid).toBe(20);               // 5 <= 10 → ma_fast * 2
  });

  it('tp ladder rounding uses Python round (half-even on the exact binary value)', () => {
    const cfg = VolumeConfig.fromParams(CASES.tp_round);
    expect(cfg.tp1_rr).toBe(1.1);
    expect(cfg.tp2_rr).toBe(1.6);            // round(1.1 + 0.5, 2)
    expect(cfg.tp3_rr).toBe(3.0);
    expect(VolumeConfig.fromParams({ vol_mult: 1.675, climax_mult: 1.0 }).climax_mult).toBe(3.67); // round(3.675, 2) → 3.67 (3.67499…)
  });
});

describe('CPython coercion helpers', () => {
  it('pyInt', () => {
    expect(pyInt(1.9)).toBe(1);
    expect(pyInt(-1.9)).toBe(-1);
    expect(pyInt(true)).toBe(1);
    expect(pyInt(' 42 ')).toBe(42);
    expect(pyInt('1_00')).toBe(100);
    expect(pyInt('+7')).toBe(7);
    expect(() => pyInt('7.0')).toThrow(PyValueError);
    expect(() => pyInt('0x10')).toThrow(PyValueError);
    expect(() => pyInt('')).toThrow(PyValueError);
    expect(() => pyInt(Number.NaN)).toThrow(PyValueError);
    expect(() => pyInt([1])).toThrow(PyValueError);
    expect(() => pyInt(Infinity)).toThrow(PyOverflowError);
  });
  it('pyFloat', () => {
    expect(pyFloat(' .5')).toBe(0.5);
    expect(pyFloat('1e1')).toBe(10);
    expect(pyFloat('2_5')).toBe(25);
    expect(pyFloat('-INF')).toBe(-Infinity);
    expect(pyFloat('inf')).toBe(Infinity);
    expect(Number.isNaN(pyFloat('nan'))).toBe(true);
    expect(pyFloat(true)).toBe(1.0);
    expect(() => pyFloat('')).toThrow(PyValueError);
    expect(() => pyFloat('0x10')).toThrow(PyValueError);
    expect(() => pyFloat('1.2.3')).toThrow(PyValueError);
    expect(() => pyFloat([1])).toThrow(PyValueError);
  });
  it('pyBool', () => {
    for (const s of ['1', 'true', 'YES', ' on ']) expect(pyBool(s)).toBe(true);
    for (const s of ['0', 'false', 'off', 'maybe', '']) expect(pyBool(s)).toBe(false);
    expect(pyBool(2)).toBe(true);
    expect(pyBool(0)).toBe(false);
    expect(pyBool(Number.NaN)).toBe(true);   // bool(float('nan')) is True
    expect(pyBool([])).toBe(false);
    expect(pyBool([0])).toBe(true);
    expect(pyBool({})).toBe(false);
  });
});

describe('minBars', () => {
  it('defaults → 225; the formula max(ema_trend, ma_slow, turn_period) + max(vol_len, swing_lookback, 10, turn_lookback + turn_slope_bars + 2) + 5', () => {
    expect(minBars(new VolumeConfig())).toBe(225);
    expect(pins.min_bars_default).toBe(225);
    expect(minBars(VolumeConfig.fromParams({ vol_len: 30 }))).toBe(235);
    expect(minBars(VolumeConfig.fromParams({ turn_lookback: 8, turn_slope_bars: 3, vol_len: 3, swing_lookback: 2 }))).toBe(218);
    expect(minBars(VolumeConfig.fromParams({ ma_slow: 300 }))).toBe(625);   // ema_trend bumped to 600
  });
});
