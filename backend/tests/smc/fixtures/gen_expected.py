"""gen_expected.py — runs the bot's smc/* Python code over frames.json and writes expected.json
(the Python-verified side of tests/smc/analysis.test.js).

Usage (pinned venv, from anywhere; GOLDEN_BOT_DIR defaults to the bot checkout):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 python -I gen_expected.py [frames.json] [expected.json]
"""
import json
import math
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
BOT_DIR = os.environ.get("GOLDEN_BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
sys.path.insert(0, BOT_DIR)

from smc.structure import get_market_structure            # noqa: E402
from smc.liquidity import find_liquidity_sweeps             # noqa: E402
from smc.order_block import get_order_blocks                # noqa: E402
from smc.fvg import get_fvg_analysis                        # noqa: E402
from smc.premium_discount import get_premium_discount       # noqa: E402
from smc.analyzer import SMCAnalyzer, SMCConfig             # noqa: E402
from squeeze_detector import compute_squeeze_score          # noqa: E402


def load_df(bars):
    arr = np.array(bars, dtype=float)
    idx = pd.to_datetime(arr[:, 0].astype("int64"), unit="ms")
    df = pd.DataFrame({"open": arr[:, 1], "high": arr[:, 2], "low": arr[:, 3], "close": arr[:, 4], "volume": arr[:, 5]}, index=idx)
    df.index.name = "open_time"
    return df


def clean(x):
    """JSON-safe copy: Timestamps → ms int, numpy scalars → python, NaN/inf → None."""
    if isinstance(x, (bool, np.bool_)):
        return bool(x)
    if isinstance(x, (int, np.integer)):
        return int(x)
    if isinstance(x, (float, np.floating)):
        x = float(x)
        return None if (math.isnan(x) or math.isinf(x)) else x
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    if isinstance(x, (pd.Timestamp, np.datetime64)):
        return int(pd.Timestamp(x).value // 10**6)
    if x is None or isinstance(x, str):
        return x
    return str(x)


def main(frames_path, out_path):
    with open(frames_path) as fh:
        frames = json.load(fh)
    F = {k: load_df(v) for k, v in frames.items()}
    out = {}

    # structure
    out["structure"] = {}
    for name in ("htf_bearish_choch_up", "htf_bearish_wick", "htf_bearish_none", "htf_bullish_bos",
                 "htf_bullish_choch_down", "htf_bullish_wick_down", "htf_short", "htf_sweep_up"):
        out["structure"][name] = clean(get_market_structure(F[name], lookback=10, bos_confirm=True, choch_enabled=True))
    out["structure_choch_disabled"] = clean(get_market_structure(F["htf_bearish_choch_up"], 10, True, False))

    # liquidity (fresh structure per run; close_required True and False)
    out["liquidity"] = {}
    for name in ("htf_sweep_up", "htf_sweep_up_noclose", "htf_sweep_down"):
        for cr in (True, False):
            s = get_market_structure(F[name], 10, True, True)
            liq = find_liquidity_sweeps(F[name], s["swing_highs"], s["swing_lows"], threshold_pct=0.1,
                                        close_required=cr, wick_ratio=0.3)
            out["liquidity"][f"{name}:{int(cr)}"] = clean(liq)

    # order blocks
    out["ob"] = {}
    bos_bull = {"detected": True, "price": 102.0, "direction": "BULLISH"}
    bos_none = {"detected": False, "price": 0.0, "direction": ""}
    for name in ("mtf_ob_plain", "mtf_ob_breaker"):
        for bname, bos in (("bos", bos_bull), ("nobos", bos_none)):
            for brk in (True, False):
                r = get_order_blocks(F[name], bos, min_impulse_pct=0.15, max_age_candles=60,
                                     mitigated_invalid=True, use_breaker_blocks=brk)
                out["ob"][f"{name}:{bname}:{int(brk)}"] = clean(r)

    # fvg
    out["fvg"] = clean(get_fvg_analysis(F["ltf_fvg"], min_gap_pct=0.08, inversed_fvg=True, partial_fill_invalid=False))
    out["fvg_no_inverse"] = clean(get_fvg_analysis(F["ltf_fvg"], 0.08, False, False))

    # premium / discount
    out["pd"] = []
    for sh, sl, cp in ((200.0, 100.0, 162.25), (200.0, 100.0, 162.35), (200.0, 100.0, 149.95), (200.0, 100.0, 150.0),
                       (200.0, 100.0, 250.0), (200.0, 100.0, 80.0), (100.0, 100.0, 120.0), (90.0, 100.0, 95.0),
                       (0.00123, 0.00101, 0.001115)):
        out["pd"].append({"in": [sh, sl, cp], "out": clean(get_premium_discount(sh, sl, cp, 1.0))})

    # analyzer (full)
    out["analyze"] = {}
    an = SMCAnalyzer(SMCConfig(FVG_ENABLED=True, CHOCH_ENABLED=True, OB_USE_BREAKER=True,
                               OB_MAX_AGE_CANDLES=80, SWEEP_CLOSE_REQUIRED=True, VOL_LEN=20))
    a = an.analyze("TEST-USDT-SWAP", F["htf_sweep_up"], F["mtf_volume"], F["ltf_fvg"])
    a["squeeze_score"] = int(compute_squeeze_score(F["mtf_volume"]) or 0)
    out["analyze"]["full"] = clean(a)
    out["analyze"]["ltf_none"] = clean(an.analyze("TEST-USDT-SWAP", F["htf_sweep_up"], F["mtf_volume"], None))
    out["analyze"]["short_htf"] = clean(an.analyze("TEST-USDT-SWAP", F["htf_short"], F["mtf_volume"], F["ltf_fvg"]))
    out["analyze"]["vol_len_3"] = clean(SMCAnalyzer(SMCConfig(VOL_LEN=3)).analyze("TEST-USDT-SWAP", F["htf_sweep_up"], F["mtf_volume"], F["ltf_fvg"]))
    out["analyze"]["fvg_disabled"] = clean(SMCAnalyzer(SMCConfig(FVG_ENABLED=False)).analyze("TEST-USDT-SWAP", F["htf_sweep_up"], F["mtf_volume"], F["ltf_fvg"]))
    # error capture: empty MTF with no BOS → IndexError in get_order_blocks
    out["analyze"]["empty_mtf"] = clean(an.analyze("TEST-USDT-SWAP", F["htf_short"], F["mtf_volume"].iloc[0:0], F["ltf_fvg"]))
    # config semantics
    c = SMCConfig(MIN_RR=2.5, vol_mult=9, _PRIVATE=1, UNKNOWN_KEY="x", VOL_LEN=20.0)
    out["config"] = {"MIN_RR": c.MIN_RR, "VOL_MULT": c.VOL_MULT, "has_vol_mult_lower": hasattr(c, "vol_mult"),
                     "has_private": hasattr(c, "_PRIVATE"), "UNKNOWN_KEY": getattr(c, "UNKNOWN_KEY", None), "VOL_LEN": c.VOL_LEN}

    with open(out_path, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write("\n")
    print("wrote", out_path)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "frames.json"),
         sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "expected.json"))
