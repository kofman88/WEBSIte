/**
 * volumeCfgShim.js — VolumeConfig from_params / _fix per strategy-volume.md §3.1
 * (worked example verified against the bot) and the VolumeConfig().to_dict()
 * JSON printed by the bot. smcUserCfg.js — SMCUserCfg.from_json / to_json.
 */
import { describe, it, expect } from 'vitest';
import vol from '../../services/engine/volumeCfgShim.js';
import smc from '../../services/engine/smcUserCfg.js';
import { pyJsonDumps } from '../../services/engine/pyjson.js';

// json.dumps(VolumeConfig().to_dict()) printed by the bot at c56653d ([VOL-MIN-VOLUME] floor 1.5, [VOL-MIN-SL] min_sl_pct_15m)
const VOL_JSON = '{"setup_cross": true, "setup_turn": true, "setup_bounce": true, "setup_golden": true, "setup_ribbon": true, "ribbon_vol_mult": 1.5, "ma_type": "sma", "ma_fast": 10, "ma_mid": 20, "ma_slow": 50, "ema_mid": 50, "ema_trend": 200, "trend_filter": true, "cross_lookback": 2, "turn_period": 20, "turn_lookback": 5, "turn_slope_bars": 2, "turn_min_slope_atr": 0.05, "bounce_tol_atr": 0.25, "bounce_vol_mult": 1.5, "vol_len": 20, "vol_mult": 1.5, "climax_mult": 4.5, "extension_atr": 2.5, "rsi_period": 14, "rsi_long_max": 70.0, "rsi_short_min": 30.0, "atr_period": 14, "use_htf": true, "htf_ema": 50, "sl_atr_mult": 2.0, "sl_buffer_atr": 0.25, "swing_lookback": 10, "max_sl_pct": 4.0, "min_sl_pct_15m": 1.0, "tp1_rr": 1.0, "tp2_rr": 2.0, "tp3_rr": 3.0, "min_quality": 3}';
const SMC_JSON = '{"tf_key": "1H", "scan_interval": 300, "direction": "BOTH", "min_confirmations": 3, "min_rr": 2.0, "sl_buffer_pct": 0.35, "min_volume_usdt": 300000.0, "fvg_enabled": true, "choch_enabled": true, "ob_use_breaker": true, "ob_max_age": 80, "sweep_close_req": true, "smc_conf_type": "BODY_CLOSE", "smc_pd_filter": false, "smc_retrace_depth": 0.2, "smc_mtf_check": false, "smc_use_volume_filter": false, "smc_vol_mult": 1.2, "smc_vol_len": 20}';

describe('VolumeConfig', () => {
  it('39 dataclass fields, defaults (__post_init__: the setup volume floor), to_dict JSON byte-identical to the bot', () => {
    expect(vol.FIELD_NAMES.length).toBe(39);   // volume_strategy.VolumeConfig at c56653d (+ min_sl_pct_15m)
    expect(vol.DEFAULTS.bounce_vol_mult).toBe(1.0);   // the dataclass default; defaults() is floored to 1.5
    expect(pyJsonDumps(vol.toDict(vol.defaults()), vol.FLOAT_KEYS)).toBe(VOL_JSON);
    expect(vol.USER_PREF_KEYS).toEqual(['setup_cross', 'setup_turn', 'setup_bounce', 'setup_golden', 'setup_ribbon', 'use_htf']);
    expect(vol.SETUP_KEYS).toEqual(['cross', 'turn', 'bounce', 'golden', 'ribbon']);
  });
  it('worked example from the spec (coercion + _fix order)', () => {
    const c = vol.fromParams({ ma_fast: 30, ma_mid: 20, tp1_rr: 0.5, tp2_rr: 0.7, climax_mult: 1.0, ma_type: 'EMA', setup_cross: 'off', vol_len: '7', rsi_long_max: 'abc' });
    expect(c).toMatchObject({ ma_fast: 30, ma_mid: 60, ma_slow: 120, ema_trend: 200, climax_mult: 3.5, tp1_rr: 1.0, tp2_rr: 1.5, tp3_rr: 3.0, ma_type: 'ema', setup_cross: false, vol_len: 7, rsi_long_max: 70.0 });
  });
  it('coercion: bool strings, int("1.5") skipped, None / unknown ignored, str lower-cased', () => {
    const c = vol.fromParams({ setup_turn: 'YES', use_htf: 0, ma_fast: '1.5', vol_mult: null, bogus: 9, ma_type: ' SMA ', min_quality: 9, swing_lookback: true });
    expect(c.setup_turn).toBe(true);
    expect(c.use_htf).toBe(false);
    expect(c.ma_fast).toBe(10);
    expect(c.vol_mult).toBe(1.5);
    expect(c).not.toHaveProperty('bogus');
    expect(c.ma_type).toBe('sma');
    expect(c.min_quality).toBe(5);
    expect(c.swing_lookback).toBe(2);          // int(True) = 1 → max(2, 1)
    expect(vol.fromParams(null)).toEqual(vol.defaults());
  });
  it('_fix: ema_trend follows ma_slow; climax follows vol_mult; min_quality 1..5; tp ladder', () => {
    const c = vol.fromParams({ ma_slow: 300, vol_mult: 5, tp2_rr: 0.2, tp3_rr: 0.1, min_quality: 0 });
    expect(c.ema_trend).toBe(600);
    expect(c.climax_mult).toBe(7.0);
    expect([c.tp1_rr, c.tp2_rr, c.tp3_rr]).toEqual([1.0, 1.5, 2.0]);
    expect(c.min_quality).toBe(1);
  });
  it('helpers: setups_enabled, ma_prefix, params_dict', () => {
    const c = vol.fromParams({ setup_cross: false, setup_golden: false, ma_type: 'ema' });
    expect(vol.setupsEnabled(c)).toEqual(['turn', 'bounce', 'ribbon']);
    expect(vol.maPrefix(c)).toBe('EMA');
    expect(vol.paramsDict(c)).not.toHaveProperty('setup_cross');
    expect(vol.paramsDict(c)).toHaveProperty('vol_mult');
  });
  it('HOOK: useEngineConfig plugs a module with the same contract (and rejects a wrong one)', () => {
    expect(vol.impl()).toBe(vol.SHIM);
    const fake = { fromParams: () => ({ ...vol.defaults(), min_quality: 4 }), toDict: (c) => ({ ...c }), defaults: () => ({ ...vol.defaults() }) };
    const active = vol.useEngineConfig(fake);
    expect(active.fromParams({}).min_quality).toBe(4);
    expect(active.USER_PREF_KEYS).toEqual(vol.USER_PREF_KEYS);
    expect(() => vol.useEngineConfig({ fromParams: 1 })).toThrow(TypeError);
    vol.useEngineConfig(null);
    expect(vol.impl()).toBe(vol.SHIM);
  });
});

describe('SMCUserCfg', () => {
  it('defaults and to_json', () => {
    expect(smc.toJson(smc.defaults())).toBe(SMC_JSON);
  });
  it('from_json ignores unknown keys, keeps values uncoerced, falls back to defaults on errors', () => {
    expect(smc.fromJson('{"tf_key": "4H", "bogus": 1, "min_rr": "2.5"}')).toMatchObject({ tf_key: '4H', min_rr: '2.5', scan_interval: 300 });
    expect(smc.fromJson('{broken')).toEqual(smc.defaults());
    expect(smc.fromJson('[1]')).toEqual(smc.defaults());
    expect(smc.fromJson('')).toEqual(smc.defaults());
    const u = { smc_cfg: '{}' };
    const cfg = smc.getSmcCfg(u);
    cfg.direction = 'LONG';
    smc.setSmcCfg(u, cfg);
    expect(u.smc_cfg).toContain('"direction": "LONG"');
    expect(u.smc_cfg.startsWith('{"tf_key": "1H", "scan_interval": 300, "direction": "LONG"')).toBe(true);
  });
});
