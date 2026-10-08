#!/usr/bin/env python3
"""gen_volume_profile.py — the bot's own LEVELS volume profile (indicator.CHMIndicator._volume_profile,
n_bins=50) on crafted frames → volume_profile_expected.json for kde.test.js.

    cd /home/user/MAIN_BOT/CHM_BREAKER_V4
    BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <prod-like venv, python 3.11>/bin/python -I \
        <site>/backend/tests/common/fixtures/gen_volume_profile.py
    rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json

numpy details the cases aim at: vols = (mask2d * (volume / spans)[:, None]).sum(axis=0) — a False cell
is 0 * share (NaN for a NaN / ±inf share, -0.0 for a negative share), the axis-0 reduction starts from
the first row (not from +0.0), lo/hi = Series.min/max (NaN skipped; an all-NaN column → NaN → the
`hi <= lo` guard does not fire). Every float is written as repr ("nan", "inf", "-inf", "-0.0" kept).
"""
import json
import math
import os
import random
import sys

BOT = os.environ.get("GOLDEN_BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
sys.dont_write_bytecode = True
sys.path.insert(0, BOT)
os.chdir(BOT)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from indicator import CHMIndicator  # noqa: E402
from scanner_mid import _cfg_to_ind  # noqa: E402
from user_manager import TradeCfg  # noqa: E402

NAN, INF = float("nan"), float("inf")


def enc(x):
    x = float(x)
    if math.isnan(x):
        return "nan"
    if math.isinf(x):
        return "inf" if x > 0 else "-inf"
    if x == 0 and math.copysign(1, x) < 0:
        return "-0.0"
    return repr(x)


def frame(lows, highs, vols):
    n = len(lows)
    idx = pd.to_datetime([1_767_225_600_000 + i * 3_600_000 for i in range(n)], unit="ms")
    lo, hi = np.array(lows, dtype=float), np.array(highs, dtype=float)
    mid = (lo + hi) / 2
    return pd.DataFrame({"open": mid, "high": hi, "low": lo, "close": mid, "volume": np.array(vols, dtype=float)},
                        index=idx.rename("open_time"))


rnd = random.Random(20261012)


def walk(n, base=100.0, width=0.6):
    lows, highs, p = [], [], base
    for _ in range(n):
        p *= 1 + rnd.uniform(-0.01, 0.01)
        w = p * rnd.uniform(0.001, width / 100)
        lows.append(p - w)
        highs.append(p + w)
    return lows, highs


cases = {}
lo, hi = walk(60)
vol = [rnd.uniform(1e3, 5e4) for _ in range(60)]
cases["random"] = (lo, hi, vol)
cases["zero_volume_all"] = (lo, hi, [0.0] * 60)
cases["neg_volume_one"] = (lo, hi, [v if j != 17 else -v for j, v in enumerate(vol)])
cases["neg_volume_all"] = (lo, hi, [-v for v in vol])
cases["neg_zero_volume_all"] = (lo, hi, [-0.0] * 60)
cases["neg_zero_volume_mix"] = (lo, hi, [(-0.0 if j % 3 else 0.0) for j in range(60)])
cases["nan_volume_one"] = (lo, hi, [v if j != 23 else NAN for j, v in enumerate(vol)])
cases["inf_volume_one"] = (lo, hi, [v if j != 5 else INF for j, v in enumerate(vol)])
cases["neginf_volume_one"] = (lo, hi, [v if j != 41 else -INF for j, v in enumerate(vol)])
# a narrow bar between two bin centres (spans = 0 → clipped to 1, every cell False)
lo2, hi2 = [100.0 + 0.5 * j for j in range(20)], [101.0 + 0.5 * j for j in range(20)]
lo2[7], hi2[7] = 100.01, 100.02
cases["nan_volume_no_span"] = (lo2, hi2, [NAN if j == 7 else 1000.0 + j for j in range(20)])
cases["neg_volume_no_span"] = (lo2, hi2, [-500.0 if j == 7 else 1000.0 + j for j in range(20)])
cases["inf_volume_no_span"] = (lo2, hi2, [INF if j == 7 else 1000.0 + j for j in range(20)])
# empty bins: two clusters at the ends of the range, the middle bins see no bar
lo3 = [100.0 + 0.01 * j for j in range(15)] + [140.0 + 0.01 * j for j in range(15)]
hi3 = [101.0 + 0.01 * j for j in range(15)] + [141.0 + 0.01 * j for j in range(15)]
cases["empty_bins"] = (lo3, hi3, [rnd.uniform(1, 100) for _ in range(30)])
cases["empty_bins_neg"] = (lo3, hi3, [-rnd.uniform(1, 100) for _ in range(30)])
# NaN highs / lows inside the frame
lo4, hi4 = walk(40)
lo4[3] = NAN
hi4[9] = NAN
lo4[12] = hi4[12] = NAN
cases["nan_low_high"] = (lo4, hi4, [rnd.uniform(10, 1000) for _ in range(40)])
cases["all_nan_lows"] = ([NAN] * 12, [100.0 + j for j in range(12)], [1.0] * 12)
cases["all_nan_highs"] = ([100.0 + j for j in range(12)], [NAN] * 12, [1.0] * 12)
cases["flat"] = ([5.0] * 30, [5.0] * 30, [rnd.uniform(1, 10) for _ in range(30)])
cases["short_9"] = (lo[:9], hi[:9], vol[:9])
cases["exactly_10"] = (lo[:10], hi[:10], vol[:10])
cases["tiny_scale"] = ([x * 1e-6 for x in lo], [x * 1e-6 for x in hi], vol)
cases["huge_volume"] = (lo, hi, [v * 1e300 for v in vol])
for k in range(12):   # seeded random frames with mixed special volumes
    n = rnd.randint(10, 120)
    lk, hk = walk(n, base=rnd.choice([0.0012, 3.4, 250.0, 61000.0]), width=rnd.choice([0.2, 0.8, 2.0]))
    vk = [rnd.choice([rnd.uniform(0, 1e5), 0.0, -0.0, -rnd.uniform(0, 10)]) if rnd.random() < 0.15 else rnd.uniform(0, 1e5)
          for _ in range(n)]
    cases[f"rand{k:02d}"] = (lk, hk, vk)

ind = CHMIndicator(_cfg_to_ind(TradeCfg()))
out = {"python": sys.version.split()[0], "numpy": np.__version__, "pandas": pd.__version__,
       "call": "CHMIndicator(_cfg_to_ind(TradeCfg()))._volume_profile(df)  # n_bins=50", "cases": {}}
for name, (lows, highs, vols) in cases.items():
    vp = ind._volume_profile(frame(lows, highs, vols))
    out["cases"][name] = {
        "low": [enc(x) for x in lows], "high": [enc(x) for x in highs], "volume": [enc(x) for x in vols],
        "hvn": [enc(x) for x in vp["hvn"]], "lvn": [enc(x) for x in vp["lvn"]],
        "bin_edges": [enc(x) for x in vp["bin_edges"]], "volumes": [enc(x) for x in vp["volumes"]],
    }
with open(os.path.join(HERE, "volume_profile_expected.json"), "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, indent=1)
    fh.write("\n")
print(f"{len(out['cases'])} cases -> volume_profile_expected.json")
