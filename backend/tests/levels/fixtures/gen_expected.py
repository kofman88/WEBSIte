#!/usr/bin/env python3
"""gen_expected.py — run the bot's OWN LEVELS code (indicator.CHMIndicator) on the
frames/cases of frames.json and write expected.json for patterns.test.js / setups.test.js.

    cd /home/user/MAIN_BOT/CHM_BREAKER_V4
    BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <pinned venv>/bin/python \
        <site>/backend/tests/levels/fixtures/gen_expected.py
    rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json

Oracles (all pure methods of a fresh CHMIndicator; nothing touches DB/Telegram):
  patterns       _detect_pattern(df)                                   → [bull, bear]
  weak_patterns  _do_analyze with LEVELS_RELAX_ENABLED=1, zones at the close, probe at
                 the first _check_fakeout call                         → [bull_pat, bear_pat]
  institutional  _detect_institutional_pattern(df, level, dir, vr, zb) → [name, bonus]
  approach       _assess_approach_quality(df, level, zb, rolling vol mean, inst) → [ok, reason]
  tests          _count_recent_tests(df, level, zone_pct, lookback)    → count
  setups         _do_analyze(..., _precomputed_zones=(sup, res)) with the bot's reject
                 bucket (_ANALYZE_STATS) and the search/approach/test intermediates
                 captured from the _do_analyze frame at the hook calls.
Floats are written with repr (round-trip exact), so the JS side can compare bit-for-bit.
"""
import json
import math
import os
import sys

BOT = os.environ.get("GOLDEN_BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
os.environ["LEVELS_RELAX_ENABLED"] = "0"
os.environ["LEVELS_REGIME_GATE"] = "enforce"
os.environ["LEVELS_VOL_GATE"] = "off"
os.environ["LEVELS_ENTRY_CONFIRM"] = "off"
os.environ["SL_V2_LEVELS_ENABLED"] = "0"
sys.path.insert(0, BOT)
os.chdir(BOT)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import indicator  # noqa: E402
from indicator import CHMIndicator  # noqa: E402
from scanner_mid import _cfg_to_ind  # noqa: E402
from user_manager import TradeCfg  # noqa: E402


def load_df(bars):
    arr = np.array(bars, dtype=float)
    idx = pd.to_datetime(arr[:, 0].astype("int64"), unit="ms")
    df = pd.DataFrame({"open": arr[:, 1], "high": arr[:, 2], "low": arr[:, 3],
                       "close": arr[:, 4], "volume": arr[:, 5]}, index=idx)
    df.index.name = "open_time"
    return df


def conv(v):
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, (int, np.integer)):
        return int(v)
    if isinstance(v, (float, np.floating)):
        v = float(v)
        return None if (math.isnan(v) or math.isinf(v)) else v
    if isinstance(v, str) or v is None:
        return v
    if isinstance(v, dict):
        return {k: conv(x) for k, x in v.items() if k != "lvn_checker"}
    if isinstance(v, (list, tuple)):
        return [conv(x) for x in v]
    return str(v)


class _Probe(Exception):
    pass


SEARCH_LOCALS = ["signal", "s_level", "s_type", "is_counter", "s_hits", "s_class", "bull_pat", "bear_pat",
                 "c_now", "atr_now", "rsi_now", "vol_ratio", "vol_avg", "bull_local", "bear_local", "trend_local",
                 "session", "is_dead_session", "dist_pct", "_sig_dist_pct", "zone_buf"]


def run_setup(scn, frames):
    df = load_df(frames[scn["frame"]])
    cfg = _cfg_to_ind(TradeCfg(**scn["cfg"]), high_wr_mode=bool(scn.get("high_wr", False)))
    ind = CHMIndicator(cfg)
    mk = lambda z: {"price": float(z["price"]), "hits": int(z["hits"]), "eff_hits": int(z["hits"]), "age_bars": 10,
                    "class": int(z["class"]), "is_psychological": False, "layers": 1, "has_hvn": False,
                    "has_lvn_to_tp": False}
    sup = [mk(z) for z in scn["zones"]["sup"]]
    res = [mk(z) for z in scn["zones"]["res"]]
    rec = {"search": None, "inst": None, "approach": None, "test_count": None}

    def hook_inst(df_, level, direction, vol_ratio, zone_buf):
        L = sys._getframe(1).f_locals
        rec["search"] = {k: conv(L.get(k)) for k in SEARCH_LOCALS}
        rec["search"]["s_zone"] = conv({k: L["s_zone"].get(k) for k in ("price", "hits", "class")})
        r = CHMIndicator._detect_institutional_pattern(ind, df_, level, direction, vol_ratio, zone_buf)
        rec["inst"] = [r[0], int(r[1])]
        return r

    def hook_appr(df_, level, zone_buf, vol_ma, inst_pattern=""):
        r = CHMIndicator._assess_approach_quality(ind, df_, level, zone_buf, vol_ma, inst_pattern=inst_pattern)
        rec["approach"] = [bool(r[0]), r[1]]
        return r

    def hook_tests(df_, level, zone_pct, lookback=30):
        r = CHMIndicator._count_recent_tests(ind, df_, level, zone_pct, lookback=lookback)
        rec["test_count"] = int(r)
        return r

    ind._detect_institutional_pattern = hook_inst
    ind._assess_approach_quality = hook_appr
    ind._count_recent_tests = hook_tests
    os.environ["LEVELS_RELAX_ENABLED"] = "1" if scn.get("relax") else "0"
    indicator.reset_analyze_stats()
    try:
        result = ind._do_analyze(scn["name"], df, None, None, None, None, _precomputed_zones=(sup, res))
    finally:
        os.environ["LEVELS_RELAX_ENABLED"] = "0"
    stats = indicator.get_analyze_stats()
    bucket = ",".join(sorted(stats)) if stats else "none"
    out = {"bucket": bucket, "returned_signal": result is not None, **rec}
    if result is not None:
        out["signal"] = {"direction": result.direction, "breakout_type": result.breakout_type,
                         "level_class": int(result.level_class), "pattern": result.pattern,
                         "test_count": int(result.test_count), "is_counter_trend": bool(result.is_counter_trend),
                         "trend_local": result.trend_local, "session": result.session}
    return out


def weak_pattern(name, frames):
    """(bull_pat, bear_pat) as seen by the setup search with LEVELS_RELAX_ENABLED=1."""
    df = load_df(frames[name])
    cfg = _cfg_to_ind(TradeCfg(use_volume=False, use_rsi=False))
    ind = CHMIndicator(cfg)
    close = float(df["close"].iloc[-1])
    zone = {"price": close, "hits": 2, "eff_hits": 2, "age_bars": 10, "class": 2, "is_psychological": False,
            "layers": 1, "has_hvn": False, "has_lvn_to_tp": False}
    got = {}

    def hook_fakeout(df_, level, direction, zone_buf):
        L = sys._getframe(1).f_locals
        got["pats"] = [L["bull_pat"], L["bear_pat"]]
        raise _Probe()

    ind._check_fakeout = hook_fakeout
    os.environ["LEVELS_RELAX_ENABLED"] = "1"
    indicator.reset_analyze_stats()
    try:
        ind._do_analyze(name, df, None, None, None, None, _precomputed_zones=([zone], []))
    except _Probe:
        pass
    finally:
        os.environ["LEVELS_RELAX_ENABLED"] = "0"
    return got.get("pats")


def main():
    with open(os.path.join(HERE, "frames.json")) as fh:
        fx = json.load(fh)
    frames = fx["frames"]
    ind = CHMIndicator(_cfg_to_ind(TradeCfg()))
    dfs = {name: load_df(bars) for name, bars in frames.items()}

    patterns = {}
    weak = {}
    for name in fx["pattern_frames"]:
        b, s = ind._detect_pattern(dfs[name])
        patterns[name] = [b, s]
        weak[name] = weak_pattern(name, frames)

    institutional = []
    for c in fx["institutional_cases"]:
        n, bonus = ind._detect_institutional_pattern(dfs[c["frame"]], c["level"], c["direction"], c["vol_ratio"], c["zone_buf"])
        institutional.append([n, int(bonus)])

    approach = []
    for c in fx["approach_cases"]:
        df = dfs[c["frame"]]
        vol_ma = df["volume"].rolling(c["vol_len"]).mean()
        ok, reason = ind._assess_approach_quality(df, c["level"], c["zone_buf"], vol_ma, inst_pattern=c["inst"])
        approach.append([bool(ok), reason])

    tests = [int(ind._count_recent_tests(dfs[c["frame"]], c["level"], c["zone_pct"], lookback=c["lookback"]))
             for c in fx["tests_cases"]]

    setups = {scn["name"]: run_setup(scn, frames) for scn in fx["setup_scenarios"]}

    out = {"python": sys.version.split()[0], "pandas": pd.__version__, "numpy": np.__version__,
           "patterns": patterns, "weak_patterns": weak, "institutional": institutional,
           "approach": approach, "tests": tests, "setups": setups}
    with open(os.path.join(HERE, "expected.json"), "w") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    from collections import Counter
    print("patterns", Counter(tuple(v) for v in patterns.values()).most_common())
    print("weak", Counter(tuple(v) if v else None for v in weak.values()).most_common())
    print("inst", Counter(v[0] for v in institutional).most_common())
    print("approach", Counter(v[1][:14] for v in approach).most_common())
    print("tests", Counter(tests).most_common())
    print("setups", Counter(v["bucket"] for v in setups.values()).most_common())
    print("setup types", Counter((v["search"] or {}).get("s_type") for v in setups.values()).most_common())


if __name__ == "__main__":
    main()
