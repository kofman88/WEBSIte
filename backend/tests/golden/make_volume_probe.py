#!/usr/bin/env python
"""make_volume_probe.py — VOLUME differential probe: the bot's analyze_volume on inputs the main
golden sweep (expected/volume.json, 3 variants × 1h growing prefix) does NOT cover.

Sections (every record has the shape of expected/volume.json, r10-rounded, so compare.js applies):
  configs    13 hand-picked configs / base timeframes: momentum setups (cross / turn / golden) in SMA
             and EMA mode, quality-1..2 signals, counter-trend, tight RSI / extension / climax gates,
             weak HTF states (EMA 5 / 8), floors of every window (short MAs), 15m and 4h base frames.
  windows    trailing frames like the live WS cache (last 300 bars) and frames of exactly min_bars
             rows, plus 24 seeded random configs drawn from genome.GENE_SPACE["VOLUME"] ranges with
             random setup / HTF / trend toggles.
  mutations  deterministic candle mutations of the fixture frames (zero-volume bars, flat bars,
             40× volume spikes → climax gate, ±4 % price steps → extension / stop ceilings /
             effective ATR), replayed identically by volume_probe.test.js.

Re-running (bot repo + pinned venv, exactly like make_golden.py — see FIXTURES.md "Re-running"):
    cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && rm -f signal_registry.json
    BOT_TOKEN_CHM=test:token ADMIN_IDS=123 GOLDEN_OUT_DIR=<backend/tests/golden> \
        <venv>/bin/python -I <backend/tests/golden>/make_volume_probe.py
writes expected/volume_probe.json.gz and probe_summary.json (counts + sha256 asserted by the test).
"""
import dataclasses as dc
import gzip
import hashlib
import json
import os
import random
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.environ.get("GOLDEN_OUT_DIR", HERE)
STEP = int(os.environ.get("GOLDEN_PROBE_STEP", "1"))
sys.path.insert(0, HERE)
import make_golden as mg  # noqa: E402  (BOT_DIR on sys.path, chdir, pinned env flags)
from volume_strategy import VolumeConfig, analyze_volume, min_bars  # noqa: E402
from squeeze_detector import compute_squeeze_score  # noqa: E402

HTF_OF = {"15m": "1h", "1h": "4h", "4h": "1d"}
HTF_WINDOW = 300
SWEEP_BARS = 200           # the last 200 bars of the base series (= WARMUP..n-1 on the 1h series)
SYMBOLS_7 = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SYNUP01-USDT-SWAP", "SYNDN03-USDT-SWAP",
             "SYNRG05-USDT-SWAP", "SYNVL06-USDT-SWAP", "SYNLV04-USDT-SWAP"]
SYMBOLS_5 = ["BTC-USDT-SWAP", "SYNUP01-USDT-SWAP", "SYNDN03-USDT-SWAP", "SYNRG05-USDT-SWAP", "SYNVL06-USDT-SWAP"]

MOMENTUM = dict(setup_bounce=False, setup_ribbon=False, min_quality=1, vol_mult=0.5, trend_filter=False, use_htf=False)
SHORT_MAS = dict(ma_fast=3, ma_mid=5, ma_slow=8, ema_mid=5, ema_trend=12, turn_period=3, vol_len=3, rsi_period=3,
                 atr_period=3, swing_lookback=3, min_quality=1, vol_mult=0.5, trend_filter=False, use_htf=False)

# name → (params, tf, window, mutate, symbols)
CASES = {
    # ── configs ──
    "momentum_sma": (MOMENTUM, "1h", None, None, SYMBOLS_7),
    "momentum_ema": (dict(MOMENTUM, ma_type="ema", ma_fast=8, ma_mid=13, turn_period=9, turn_lookback=3,
                          turn_slope_bars=1, cross_lookback=5), "1h", None, None, SYMBOLS_7),
    "filters_tight": (dict(min_quality=1, vol_mult=0.5, climax_mult=0.6, extension_atr=0.5, rsi_long_max=55.0,
                           rsi_short_min=45.0, use_htf=True, htf_ema=8), "1h", None, None, SYMBOLS_7),
    "bounce_loose": (dict(setup_cross=False, setup_turn=False, setup_golden=False, setup_ribbon=False,
                          bounce_tol_atr=1.0, bounce_vol_mult=0.3, min_quality=1, trend_filter=False,
                          sl_atr_mult=5.0, max_sl_pct=20.0, swing_lookback=2, sl_buffer_atr=0.0), "1h", None, None, SYMBOLS_7),
    "ribbon_only": (dict(setup_cross=False, setup_turn=False, setup_golden=False, setup_bounce=False,
                         ribbon_vol_mult=0.5, min_quality=1, trend_filter=False, use_htf=False,
                         tp1_rr=1.5, tp2_rr=2.5, tp3_rr=4.0), "1h", None, None, SYMBOLS_7),
    "turn_only_sma": (dict(setup_cross=False, setup_bounce=False, setup_golden=False, setup_ribbon=False,
                           turn_min_slope_atr=0.0, turn_lookback=2, turn_slope_bars=5, vol_mult=0.5,
                           min_quality=1, trend_filter=False, use_htf=False), "1h", None, None, SYMBOLS_7),
    "golden_only": (dict(setup_cross=False, setup_turn=False, setup_bounce=False, setup_ribbon=False,
                         ema_mid=20, ema_trend=60, min_quality=1, trend_filter=False, use_htf=True), "1h", None, None, SYMBOLS_7),
    "short_mas": (SHORT_MAS, "1h", None, None, SYMBOLS_7),
    "htf_weak": (dict(htf_ema=5, min_quality=1, vol_mult=0.5, trend_filter=False), "1h", None, None, SYMBOLS_7),
    "default_mq1": (dict(min_quality=1), "1h", None, None, SYMBOLS_7),
    "tf15m_default": ({}, "15m", None, None, SYMBOLS_7),
    "tf4h_default": ({}, "4h", None, None, SYMBOLS_7),
    "tf15m_momentum": (dict(MOMENTUM, use_htf=True), "15m", None, None, SYMBOLS_7),
    # ── windows ──
    "win300_default": ({}, "1h", 300, None, SYMBOLS_5),
    "win300_active": (dict(min_quality=2, ma_type="ema", ma_fast=9, ma_mid=21, trend_filter=False, use_htf=False,
                           vol_mult=1.2), "1h", 300, None, SYMBOLS_5),
    "winmin_default": ({}, "1h", "minbars", None, SYMBOLS_5),
    "winmin_momentum": (dict(MOMENTUM, use_htf=True), "1h", "minbars", None, SYMBOLS_5),
    "win300_15m": ({}, "15m", 300, None, SYMBOLS_5),
}

# ── 24 seeded random configs (genome.GENE_SPACE["VOLUME"] ranges + random toggles) ──
GENES = {
    "ma_type": ["sma", "ema"], "ma_fast": [5, 8, 9, 10, 12], "ma_mid": [20, 21, 26, 30], "ma_slow": [50, 55, 100],
    "ema_trend": [150, 200], "cross_lookback": [1, 2, 3], "turn_period": [10, 20], "turn_lookback": [3, 4, 5, 6, 8],
    "turn_slope_bars": [1, 2, 3], "vol_len": [14, 20, 30], "swing_lookback": [5, 8, 10, 14],
}
FLOATS = {  # (min, max, step)
    "bounce_tol_atr": (0.1, 0.5, 0.05), "bounce_vol_mult": (0.8, 1.5, 0.1), "vol_mult": (1.2, 2.5, 0.1),
    "climax_mult": (3.5, 6.0, 0.5), "extension_atr": (1.5, 3.5, 0.25), "sl_atr_mult": (1.2, 3.0, 0.1),
    "tp1_rr": (1.0, 1.6, 0.1), "tp2_rr": (1.5, 3.0, 0.1),
}
INTS = {"rsi_long_max": (62, 78), "rsi_short_min": (22, 38), "min_quality": (1, 3)}
SETUPS = ("setup_cross", "setup_turn", "setup_bounce", "setup_golden", "setup_ribbon")


def random_params(rng):
    p = {k: rng.choice(v) for k, v in GENES.items()}
    for k, (lo, hi, st) in FLOATS.items():
        p[k] = round(lo + rng.randint(0, int(round((hi - lo) / st))) * st, 2)
    for k, (lo, hi) in INTS.items():
        p[k] = rng.randint(lo, hi)
    for k in SETUPS:
        p[k] = rng.random() < 0.7
    if not any(p[k] for k in SETUPS):
        p["setup_bounce"] = True
    p["use_htf"] = rng.random() < 0.5
    p["trend_filter"] = rng.random() < 0.5
    return p


_rng = random.Random(20261008)
for _k in range(24):
    CASES[f"rand{_k:02d}"] = (random_params(_rng), "1h", None, None, SYMBOLS_5)

# ── mutations ──
MUTATIONS = {
    "zero_vol": dict(zero_volume_every=7),
    "flat": dict(flat_every=11),
    "spike": dict(spike_every=13),
    "gap": dict(gap_every=17),
    "all": dict(zero_volume_every=7, flat_every=11, spike_every=13, gap_every=17),
}
MUT_CONFIGS = {"default": {}, "momentum": dict(MOMENTUM, use_htf=True), "short": SHORT_MAS}
for _m in MUTATIONS:
    for _c in MUT_CONFIGS:
        CASES[f"{_m}__{_c}"] = (MUT_CONFIGS[_c], "1h", None, MUTATIONS[_m], SYMBOLS_5)


def mutate(df, mut):
    """Deterministic candle mutation (bar index j of the FULL base frame) — mirrored in volume_probe.test.js."""
    if not mut:
        return df
    df = df.copy()
    o, h, l, c, v = (df[k].to_numpy().copy() for k in ("open", "high", "low", "close", "volume"))
    zv, fl, sp, gp = (mut.get(k) for k in ("zero_volume_every", "flat_every", "spike_every", "gap_every"))
    factor = 1.0
    for j in range(len(df)):
        if gp and j % gp == 9:
            factor *= 1.04 if (j // gp) % 2 == 0 else 0.96
        if gp:
            o[j] *= factor; h[j] *= factor; l[j] *= factor; c[j] *= factor
        if fl and j % fl == 5:
            o[j] = h[j] = l[j] = c[j]
        if sp and j % sp == 2:
            v[j] *= 40.0
        if zv and j % zv == 3:
            v[j] = 0.0
    return df.assign(open=o, high=h, low=l, close=c, volume=v)


def run_case(name, params, tf, window, mut, symbols, frames_by_sym):
    cfg = VolumeConfig.from_params(dict(params))
    W = min_bars(cfg) if window == "minbars" else window
    res = {"params": params, "tf": tf, "window": W, "mutate": mut, "volume_config": cfg.to_dict(),
           "min_bars": min_bars(cfg), "fixtures": {}}
    htf_tf = HTF_OF[tf]
    for sym in symbols:
        frames = frames_by_sym[sym]
        df_all, df_h_all = mutate(frames[tf], mut), frames[htf_tf]
        oms = mg.open_ms(df_all)
        n = len(df_all)
        idx = list(range(n - SWEEP_BARS, n, STEP))
        if idx[-1] != n - 1:
            idx.append(n - 1)
        signals, errors = [], []
        for i in idx:
            df = df_all.iloc[max(0, i - W + 1):i + 1] if W else df_all.iloc[:i + 1]
            close_ms = int(oms[i]) + mg.TF_MS[tf]
            df_htf = mg.aligned_prefix(df_h_all, htf_tf, close_ms, HTF_WINDOW) if cfg.use_htf else None
            mg._CAP.records.clear()
            sig = analyze_volume(sym, df, cfg, tf, df_htf)
            if mg._CAP.records:   # analyze_volume swallows exceptions and logs [VOLUME-ERR]
                errors.append({"i": i, "records": list(mg._CAP.records)})
            if sig is None:
                continue
            d = dc.asdict(sig)
            sq = 0 if sig.setup in ("bounce", "ribbon") else int(compute_squeeze_score(df) or 0)
            q_after = min(5, d["quality"] + 1) if sq >= 1 else d["quality"]
            d.update(i=i, open_time_ms=int(oms[i]), n_bars=len(df),
                     n_htf_bars=(len(df_htf) if df_htf is not None else 0),
                     tp=sig.tp, risk_pct=sig.risk_pct, volume_ratio=sig.volume_ratio,
                     squeeze_score=sq, quality_after_squeeze=q_after,
                     passes_ctx_gate=bool(q_after >= cfg.min_quality))
            signals.append(mg.r10(d))
        res["fixtures"][sym] = {"swept": [idx[0], n - 1, STEP], "n_swept": len(idx), "n_signals": len(signals),
                                "signals": signals, "errors": errors}
        print(f"  {name:<18} {sym:<20} W={W} swept={len(idx)} signals={len(signals)} errors={len(errors)}", flush=True)
    return res


def main():
    import numpy as np
    import pandas as pd
    mg._attach_capture()
    t0 = time.time()
    syms = sorted({s for c in CASES.values() for s in c[4]})
    frames_by_sym = {s: {t: mg.load_df(OUT_DIR, s, t) for t in ("15m", "1h", "4h", "1d")} for s in syms}
    out = {"probe": "volume", "python": sys.version.split()[0], "pandas": pd.__version__, "numpy": np.__version__,
           "step": STEP, "sweep_bars": SWEEP_BARS, "htf_window": HTF_WINDOW,
           "call": "sig = volume_strategy.analyze_volume(symbol, df, VolumeConfig.from_params(params), tf, df_htf)",
           "frame_rule": "df = base.iloc[:i+1] (window null) or base.iloc[max(0,i-window+1):i+1]; df_htf = bars of "
                         "HTF_OF[tf] closed at open_time[i]+tf, last 300, only when use_htf; mutate() first",
           "cases": {}}
    for name, (params, tf, window, mut, symbols) in CASES.items():
        out["cases"][name] = run_case(name, params, tf, window, mut, symbols, frames_by_sym)
    raw = json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    exp_dir = os.path.join(OUT_DIR, "expected")
    os.makedirs(exp_dir, exist_ok=True)
    with gzip.open(os.path.join(exp_dir, "volume_probe.json.gz"), "wb", mtime=0) as fh:
        fh.write(raw)
    n_sig = sum(f["n_signals"] for c in out["cases"].values() for f in c["fixtures"].values())
    n_bars = sum(f["n_swept"] for c in out["cases"].values() for f in c["fixtures"].values())
    n_err = sum(len(f["errors"]) for c in out["cases"].values() for f in c["fixtures"].values())
    summary = {"probe": "volume", "cases": len(out["cases"]), "bars": n_bars, "signals": n_sig, "errors": n_err,
               "per_case": {k: sum(f["n_signals"] for f in v["fixtures"].values()) for k, v in out["cases"].items()},
               "sha256": {"expected/volume_probe.json": hashlib.sha256(raw).hexdigest()},
               "elapsed_s": round(time.time() - t0, 1)}
    with open(os.path.join(OUT_DIR, "probe_summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1)
    print(f"done: {len(out['cases'])} cases, {n_bars} bars, {n_sig} signals, {n_err} errors, "
          f"{summary['elapsed_s']}s -> expected/volume_probe.json.gz ({len(raw)} bytes raw)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
