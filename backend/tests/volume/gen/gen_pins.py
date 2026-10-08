#!/usr/bin/env python3
"""gen_pins.py — tests/volume/pins.json: the bot's own volume_strategy.py / volume_scanner.py on the
frames of tests/volume/frames.js (detector sweeps + signal_at per scenario) and on the hand-built
inputs of the non-detector VOLUME unit tests (config coercion, structure, HTF state, resample,
scanner helpers, rejection / ribbon order).

    cd /home/user/MAIN_BOT/CHM_BREAKER_V4
    BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <prod-like venv, python 3.11>/bin/python -I \
        <site>/backend/tests/volume/gen/gen_pins.py [OUT]        # OUT defaults to tests/volume/pins.json
    rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json

`node gen_pins.js dump` supplies the scenario bars (frames.js dumpScenarios()); every float the bot
returns is written as repr(), and `node gen_pins.js assemble` parses those strings back (the identical
doubles; "inf" / "-inf" / "nan" stay strings, see pins.js pinNum) and writes the JSON.stringify layout.
"""
import dataclasses
import json
import os
import subprocess
import sys

BOT = os.environ.get("GOLDEN_BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "..", "pins.json")
NODE = os.environ.get("NODE", "node")
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
sys.dont_write_bytecode = True
sys.path.insert(0, BOT)
os.chdir(BOT)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import volume_scanner as vsc  # noqa: E402
import volume_strategy as vs  # noqa: E402


def load(bars):
    arr = np.array(bars, dtype=float)
    idx = pd.to_datetime(arr[:, 0].astype(np.int64), unit="ms")
    return pd.DataFrame({"open": arr[:, 1], "high": arr[:, 2], "low": arr[:, 3], "close": arr[:, 4],
                         "volume": arr[:, 5]}, index=idx.rename("open_time"))


def clean(x):
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    if isinstance(x, (np.bool_, bool)):
        return bool(x)
    if isinstance(x, (np.floating, float)):
        return repr(float(x))
    if isinstance(x, (np.integer,)):
        return int(x)
    return x


def scenario_pins(scen):
    """Every detector hit (bar × direction × detector, dict order) and every signal_at per scenario."""
    cfg = vs.VolumeConfig()
    out = {}
    for name, bars in scen.items():
        df = load(bars)
        ctx = vs.VolumeContext(df, cfg)
        hits = []
        for i in range(ctx.n):
            for s in (1, -1):
                for key, fn in vs._DETECTORS.items():
                    h = fn(ctx, i, s)
                    if h is not None:
                        hits.append({"i": i, "s": s, **clean(h)})
        sigs = []
        for i in range(ctx.n):
            sg = vs.signal_at(ctx, i, "TEST", "1h")
            if sg is not None:
                sigs.append({"i": i, **clean(dataclasses.asdict(sg)), "tp": clean(sg.tp), "risk_pct": clean(sg.risk_pct)})
        out[name] = {"n": ctx.n, "hits": hits, "signals": sigs}
    return out


def unit_pins():
    """Pins of the non-detector VOLUME unit tests (inputs repeated literally in the JS tests)."""
    out = {}

    # ── from_params coercion ──
    cases = {
        "spec_example": {"ma_fast": 30, "ma_mid": 20, "tp1_rr": 0.5, "tp2_rr": 0.7, "climax_mult": 1.0, "ma_type": "EMA",
                         "setup_cross": "off", "vol_len": "7", "rsi_long_max": "abc"},
        "variants_conservative": {"min_quality": 4, "vol_mult": 2.0, "trend_filter": True, "use_htf": True, "bounce_vol_mult": 1.2},
        "variants_active": {"min_quality": 2, "ma_type": "ema", "ma_fast": 9, "ma_mid": 21, "trend_filter": False, "use_htf": False,
                            "vol_mult": 1.2, "setup_ribbon": True},
        "coercion_mix": {"ma_fast": 1.9, "ma_mid": "  21 ", "ma_slow": "1_00", "vol_mult": "2_5", "use_htf": "YES", "setup_turn": 0,
                         "setup_bounce": "maybe", "setup_golden": 2, "turn_period": "7.0", "atr_period": "0x10", "sl_atr_mult": " .5",
                         "max_sl_pct": "1e1", "min_quality": "9", "ma_type": 5, "unknown_key": 1, "to_dict": 1, "ema_mid": None,
                         "cross_lookback": -3, "turn_slope_bars": 99, "extension_atr": "inf", "rsi_period": True, "tp3_rr": "",
                         "bounce_tol_atr": [1], "htf_ema": False},
        "empty": {},
        "fix_cascade": {"ma_fast": 100, "ema_mid": 1, "ema_trend": 10, "ma_slow": 300, "climax_mult": 0.1, "vol_mult": 0.1,
                        "tp1_rr": 3.0, "tp2_rr": 1.0, "tp3_rr": 1.0, "vol_len": 1, "bounce_vol_mult": 0.0, "swing_lookback": 0,
                        "turn_lookback": 0, "turn_period": 1, "htf_ema": 2, "sl_buffer_atr": -1, "turn_min_slope_atr": -0.1,
                        "extension_atr": 0.1, "min_quality": 0},
        "tp_round": {"tp1_rr": 1.1, "tp2_rr": 1.05},
    }
    cfgs = {}
    for name, params in cases.items():
        cfg = vs.VolumeConfig.from_params(params)
        cfgs[name] = {k: (repr(v) if isinstance(v, float) else v) for k, v in cfg.to_dict().items()}
        cfgs[name]["__min_bars"] = vs.min_bars(cfg)
        cfgs[name]["__setups"] = cfg.setups_enabled()
        cfgs[name]["__prefix"] = cfg.ma_prefix()
    try:
        vs.VolumeConfig.from_params({"ma_fast": float("inf")})
        cfgs["int_inf"] = "no error"
    except OverflowError as e:
        cfgs["int_inf"] = "OverflowError: %s" % e
    cfgs["__field_order"] = list(vs.VolumeConfig().to_dict().keys())
    cfgs["__params_dict_keys"] = list(vs.VolumeConfig().params_dict().keys())
    out["config"] = cfgs

    # ── nearest_structure / effective_atr ──
    ns = {}
    h = np.array([100, 110, 105, 101, 100, 99, 103, 101, 100, 99.5], float)
    l = h - 1.0
    ns["short_pinned"] = repr(vs.nearest_structure(h, l, 9, -1, 10))
    l2 = np.array([100, 85, 95, 97, 96, 98, 90, 94, 95, 96], float)
    ns["long_pinned"] = repr(vs.nearest_structure(l2 + 1.0, l2, 9, 1, 10))
    h3 = np.array([100, 101, 102, 103, 104, 105, 106, 107, 108, 120], float)
    ns["short_monotonic_lb5"] = repr(vs.nearest_structure(h3, h3 - 1.0, 9, -1, 5))
    ns["long_i1"] = repr(vs.nearest_structure(l2 + 1.0, l2, 1, 1, 10))
    ns["long_lb2"] = repr(vs.nearest_structure(l2 + 1.0, l2, 9, 1, 2))
    tr = np.array([1.0, 2.0, np.nan, 4.0, 0.5], float)
    ns["eff_atr_i4"] = repr(vs.effective_atr(1.0, tr, 4))
    ns["eff_atr_i2_nan"] = repr(vs.effective_atr(1.0, tr, 2))
    ns["eff_atr_i0"] = repr(vs.effective_atr(3.0, tr, 0))
    ns["eff_atr_allnan"] = repr(vs.effective_atr(2.5, np.array([np.nan, np.nan, np.nan]), 2))
    ns["eff_atr_zero"] = repr(vs.effective_atr(2.5, np.array([0.0, 0.0, 0.0]), 2))
    out["structure"] = ns

    # ── HTF state arrays ──
    close = np.array([10, 11, 12, 11, 10, 9, 9, 9, 10, 12], float)
    ema = np.array([10, 10.5, 11, 11, 10.8, 10.5, 10.2, 10, 10, 10.5], float)
    out["htf_state_arrays"] = [int(x) for x in vs._htf_state_arrays(close, ema)]
    out["htf_state_arrays_equal"] = [int(x) for x in vs._htf_state_arrays(np.array([5.0, 5.0, 5.0, 5.0]), np.array([5.0, 5.0, 5.0, 5.0]))]

    # ── htf_state on short / long frames ──
    T0 = 1767225600000  # 2026-01-01 00:00 UTC
    H = 3600000

    def hourly(n, f, start=T0):
        return [[start + j * H, f(j), f(j) + 0.5, f(j) - 0.5, f(j), 100 + j] for j in range(n)]

    cfg = vs.VolumeConfig()
    hs = {}
    hs["28_rows"] = vs.htf_state(load(hourly(28, lambda j: 100 + j)), cfg)
    hs["29_rows_up"] = vs.htf_state(load(hourly(29, lambda j: 100 + j)), cfg)
    hs["29_rows_down"] = vs.htf_state(load(hourly(29, lambda j: 100 - j)), cfg)
    hs["60_rows_up_then_dip"] = vs.htf_state(load(hourly(60, lambda j: (100 + j) if j < 59 else 100)), cfg)
    hs["none"] = vs.htf_state(None, cfg)
    hs["htf_ema_8_rows_7"] = vs.htf_state(load(hourly(7, lambda j: 100 + j)), vs.VolumeConfig.from_params({"htf_ema": 8}))
    hs["htf_ema_8_rows_8"] = vs.htf_state(load(hourly(8, lambda j: 100 + j)), vs.VolumeConfig.from_params({"htf_ema": 8}))
    out["htf_state"] = hs

    # ── resample_htf: hourly bars starting 02:00, 4h buckets, trailing cut ──
    rs = {}
    bars = hourly(14, lambda j: 100 + j, start=T0 + 2 * H)     # 02:00 .. 15:00
    df = load(bars)
    agg = vs.resample_htf(df, "1h")
    rs["from_02_14bars"] = {"t": [int(t.value // 10**6) for t in agg.index], "o": agg["open"].tolist(), "h": agg["high"].tolist(),
                            "l": agg["low"].tolist(), "c": agg["close"].tolist(), "v": agg["volume"].tolist()}
    bars = hourly(16, lambda j: 100 + j, start=T0 + 2 * H)     # 02:00 .. 17:00 → buckets 00(partial),04,08,12 closed; 16 open
    agg = vs.resample_htf(df.iloc[:0], "1h")
    rs["empty"] = None if agg is None else len(agg)
    agg = vs.resample_htf(load(bars), "1h")
    rs["from_02_16bars_n"] = len(agg)
    rs["from_02_16bars_last_t"] = int(agg.index[-1].value // 10**6)
    agg = vs.resample_htf(load(hourly(3, lambda j: 100 + j, start=T0 + 2 * H)), "1h")   # 02,03,04 → bucket 00 not closed
    rs["from_02_3bars"] = None if agg is None else len(agg)
    rs["unknown_tf"] = vs.resample_htf(df, "1d")
    rs["15m_to_1h"] = None
    q = [[T0 + j * 900000, 1 + j, 2 + j, 0.5 + j, 1.5 + j, 10] for j in range(10)]   # 10 × 15m → 1h buckets 00, 01 (4 bars), 02 (2 → open)
    agg = vs.resample_htf(load(q), "15m")
    rs["15m_to_1h"] = {"t": [int(t.value // 10**6) for t in agg.index], "o": agg["open"].tolist(), "c": agg["close"].tolist(),
                       "v": agg["volume"].tolist()}
    out["resample"] = rs

    # ── htf_state_series on a synthetic hourly series (4h HTF) ──
    n = 400

    def path(j):
        return 100 + 0.2 * j if j < 200 else 140 - 0.3 * (j - 200)

    df = load(hourly(n, path, start=T0 + 1 * H))    # starts 01:00 → first 4h bucket partial
    ser = vs.htf_state_series(df, "1h", cfg)
    out["htf_state_series"] = {"n": int(len(ser)), "values": [int(x) for x in ser],
                               "first_nonzero": int(np.argmax(ser != 0)) if (ser != 0).any() else -1}
    out["htf_state_series_short"] = vs.htf_state_series(load(hourly(5, path)), "1h", cfg)
    out["htf_state_series_15m"] = [int(x) for x in vs.htf_state_series(
        load([[T0 + j * 900000, 100 + j, 101 + j, 99 + j, 100 + j, 1] for j in range(130)]), "15m", cfg)]

    # ── scanner helpers ──
    out["dedup_ttl"] = {tf: vsc.dedup_ttl_s(tf) for tf in ("15m", "1h", "4h", "1d", "1H", "", "7x")}
    out["htf_for"] = {tf: vs.htf_for(tf) for tf in ("15m", "1h", "1H", "4h", "1d", "", "x")}
    out["min_bars_default"] = vs.min_bars(cfg)

    sig = vs.VolumeSignal(symbol="S", direction="LONG", entry=100.0, sl=98.0, tp1=102.0, tp2=104.0, tp3=106.0, rr=2.0, quality=4,
                          signal_type="MA Cross 10/20", rsi=50.0, vol_ratio=1.5, ema_fast=1, ema_slow=1, ema_trend=1, atr=1, setup="cross")
    out["sig_props"] = {"tp": repr(sig.tp), "risk_pct": repr(sig.risk_pct), "volume_ratio": repr(sig.volume_ratio),
                        "risk_pct_zero_entry": repr(dataclasses.replace(sig, entry=0.0).risk_pct),
                        "asdict_keys": list(dataclasses.asdict(sig).keys())}

    # ── _rejection / _ribbon_order on hand-built bars ──
    class _Ctx:
        pass

    def rej(bars, i, s):
        c = _Ctx()
        arr = np.array(bars, float)
        c.o, c.h, c.l, c.c = arr[:, 0], arr[:, 1], arr[:, 2], arr[:, 3]
        return vs._rejection(c, i, s)

    R = {}
    R["hammer_long"] = rej([[10, 10.2, 9.0, 10.1]], 0, 1)             # o,h,l,c: body 0.1, tail 1.0, nose 0.1
    R["hammer_long_as_short"] = rej([[10, 10.2, 9.0, 10.1]], 0, -1)
    R["hammer_short"] = rej([[10, 11.0, 9.9, 9.95]], 0, -1)
    R["doji_tail_rule"] = rej([[10, 10.3, 9.0, 10.0]], 0, 1)          # body 0 → tail ≥ 2·0.05·rng
    R["nose_too_big"] = rej([[10, 10.8, 9.0, 10.1]], 0, 1)            # nose 0.7 > 0.35·1.8
    R["engulf_long"] = rej([[10.5, 10.6, 9.9, 10.0], [9.95, 10.9, 9.9, 10.7]], 1, 1)
    R["engulf_long_open_above_prev_close"] = rej([[10.5, 10.6, 9.9, 10.0], [10.05, 10.9, 9.9, 10.7]], 1, 1)
    R["engulf_short"] = rej([[10.0, 10.6, 9.9, 10.5], [10.55, 10.6, 9.5, 9.8]], 1, -1)
    R["bearish_body_long"] = rej([[10.5, 10.6, 10.0, 10.1]], 0, 1)
    R["zero_range"] = rej([[10, 10, 10, 10]], 0, 1)
    R["engulf_needs_prev"] = rej([[9.95, 10.9, 9.9, 10.7]], 0, 1)
    out["rejection"] = R
    rib = np.array([[8, 7, 6, 5, 4, 3, 2, 1], [1, 2, 3, 4, 5, 6, 7, 8], [8, 7, 6, 5, 4, 3, 2, np.nan], [5, 5, 5, 5, 5, 5, 5, 5],
                    [8, 7, 6, 5, 1, 2, 3, 4]], float).T
    out["ribbon_order"] = [repr(vs._ribbon_order(rib, j, s)) for j in range(5) for s in (1, -1)]
    return out


def main():
    js = os.path.join(HERE, "gen_pins.js")
    scen = json.loads(subprocess.run([NODE, js, "dump"], check=True, capture_output=True, encoding="utf-8").stdout)
    raw = {"python": sys.version.split()[0], "pandas": pd.__version__, "numpy": np.__version__,
           "scenarios": scenario_pins(scen), **unit_pins()}
    subprocess.run([NODE, js, "assemble", OUT], input=json.dumps(raw, ensure_ascii=False, allow_nan=False), check=True,
                   encoding="utf-8")
    print("pins ->", OUT, "python", raw["python"], "scenarios", len(raw["scenarios"]))


if __name__ == "__main__":
    main()
