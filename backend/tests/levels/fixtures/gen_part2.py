#!/usr/bin/env python3
"""gen_part2.py — run the bot's OWN code for the LEVELS part-2 modules (M6) and write
part2_expected.json for part2.test.js / marketRegime.test.js.

    cd /home/user/MAIN_BOT/CHM_BREAKER_V4
    BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <pinned venv>/bin/python \
        <site>/backend/tests/levels/fixtures/gen_part2.py
    rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json

Oracles (pure functions / methods; nothing touches DB/Telegram):
  regime         market_regime.detect_regime(df, tf=…) on real golden frames (1h prefixes, 1d
                 frames, explicit slope_thresh / ema_period overrides, a crafted high-vol frame)
                 + every bar found where tf="1d" and tf="1D" disagree (the lowercase-key quirk)
  stars          quality_scale.levels_stars / stars_str on a table of inputs
  magnets        liquidity_sl_adjuster.adjust_sl_for_magnets on seeded random cases
  coin_class     the indicator's memcoin keyword / BTC-ETH substring rule on a symbol table
                 (the keyword tuple is parsed from indicator.py and asserted)
  relaxed        momentum_detector.relax_min_rr / relax_min_quality with relaxed mode forced on
  atr_breakout   momentum_detector.detect_atr_breakout on real frames (cooldown reset per call)
                 and the SignalResult analyze() builds from it in relaxed mode
  part2_locals   for every golden bar that reached part 2 (fixture reject in sl_risk / rr /
                 checklist / quality_hwr / levels_filter, or a signal): the locals of the
                 bot's _do_analyze frame at return (sl before/after magnets, risk, class flags,
                 structural TPs, scale, final TPs, rr_actual, rr_score, corr, divergence, LVN,
                 HTF, quality, reasons, checklist, explanation, filter verdict).
Floats are written with repr (round-trip exact) so the JS side compares bit-for-bit.
"""
import gzip
import json
import math
import os
import random
import re
import sys

BOT = os.environ.get("GOLDEN_BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN = os.path.normpath(os.path.join(HERE, "..", "..", "golden"))
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
os.environ["LEVELS_RELAX_ENABLED"] = "0"
os.environ["LEVELS_REGIME_GATE"] = "enforce"
os.environ["LEVELS_VOL_GATE"] = "off"
os.environ["LEVELS_ENTRY_CONFIRM"] = "off"
os.environ["SL_V2_LEVELS_ENABLED"] = "0"
os.environ["SL_V2_SMC_ENABLED"] = "0"
for k, v in (("SQUEEZE_BB_LOOKBACK", "50"), ("SQUEEZE_BB_PCTILE_STRONG", "15"), ("SQUEEZE_BB_PCTILE_SOME", "30"),
             ("SQUEEZE_ATR_RATIO_STRONG", "0.7"), ("SQUEEZE_ATR_RATIO_SOME", "0.85")):
    os.environ[k] = v
sys.path.insert(0, BOT)
os.chdir(BOT)

import dataclasses  # noqa: E402

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import indicator  # noqa: E402
import market_regime  # noqa: E402
import momentum_detector as md  # noqa: E402
import quality_scale  # noqa: E402
from indicator import CHMIndicator  # noqa: E402
from liquidity_sl_adjuster import adjust_sl_for_magnets  # noqa: E402
from scanner_mid import _cfg_to_ind  # noqa: E402
from user_manager import TradeCfg  # noqa: E402

TF_MS = {"15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
LATE = ("sl_risk", "rr", "checklist", "quality_hwr", "levels_filter")


def load_df(bars):
    arr = np.array(bars, dtype=float)
    idx = pd.to_datetime(arr[:, 0].astype("int64"), unit="ms")
    df = pd.DataFrame({"open": arr[:, 1], "high": arr[:, 2], "low": arr[:, 3],
                       "close": arr[:, 4], "volume": arr[:, 5]}, index=idx)
    df.index.name = "open_time"
    return df


def load_candles(symbol, tf):
    with open(os.path.join(GOLDEN, "candles", f"{symbol}_{tf}.json"), encoding="utf-8") as f:
        fx = json.load(f)
    assert fx["symbol"] == symbol and fx["tf"] == tf
    return load_df(fx["bars"])


def load_expected_levels():
    p = os.path.join(GOLDEN, "expected", "levels.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    with gzip.open(p + ".gz", "rt", encoding="utf-8") as f:
        return json.load(f)


def aligned_prefix(df, tf, close_ms, window):
    oms = (df.index.values.astype("datetime64[ms]").astype("int64"))
    n = int(np.searchsorted(oms + TF_MS[tf], close_ms, side="right"))
    sub = df.iloc[:n]
    if window:
        sub = sub.iloc[-window:]
    return sub if len(sub) else None


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


# ── regime ──────────────────────────────────────────────────────────────────────────────
REGIME_SYMBOLS = ["SYNUP01-USDT-SWAP", "SYNDN01-USDT-SWAP", "SYNRG01-USDT-SWAP", "SYNVL01-USDT-SWAP",
                  "SYNLV01-USDT-SWAP", "BTC-USDT-SWAP", "PEPEVL07-USDT-SWAP"]
REGIME_TFS = [None, "1h", "1H", "15m", "5m", "1m", "30m", "4h", "4H", "2H", "1d", "1D", "3m", "xx", ""]


def gen_regime(all_symbols):
    cases = []
    for sym in REGIME_SYMBOLS:
        df1h = load_candles(sym, "1h")
        for n in (54, 55, 60, 100, 200, 300, 400):
            df = df1h.iloc[:n]
            for tf in REGIME_TFS:
                cases.append(dict(symbol=sym, tf_src="1h", n=n, tf=tf, regime=market_regime.detect_regime(df, tf=tf)))
            cases.append(dict(symbol=sym, tf_src="1h", n=n, tf="1h", slope_thresh=0.0001,
                              regime=market_regime.detect_regime(df, slope_thresh=0.0001, tf="1h")))
            cases.append(dict(symbol=sym, tf_src="1h", n=n, tf="5m", slope_thresh=0.01,
                              regime=market_regime.detect_regime(df, slope_thresh=0.01, tf="5m")))
            cases.append(dict(symbol=sym, tf_src="1h", n=n, tf="15m", ema_period=20, atr_period=7,
                              regime=market_regime.detect_regime(df, ema_period=20, atr_period=7, tf="15m")))
            cases.append(dict(symbol=sym, tf_src="1h", n=n, tf="1h", high_vol_pct=0.001,
                              regime=market_regime.detect_regime(df, high_vol_pct=0.001, tf="1h")))
        df1d = load_candles(sym, "1d")
        for tf in (None, "1d", "1D"):
            cases.append(dict(symbol=sym, tf_src="1d", n=len(df1d), tf=tf, regime=market_regime.detect_regime(df1d, tf=tf)))
    # crafted high-vol frame: widen every bar's range ×25 around its close
    base = load_candles("SYNVL01-USDT-SWAP", "1h").iloc[:200].copy()
    rng = (base["high"] - base["low"]) * 25
    base["high"] = base["close"] + rng / 2
    base["low"] = (base["close"] - rng / 2).clip(lower=1e-9)
    cases.append(dict(symbol="CRAFTED_HIGH_VOL", tf_src="1h", n=200, tf="1h", regime=market_regime.detect_regime(base, tf="1h"),
                      bars=[[int(t.value // 10**6), float(r.open), float(r.high), float(r.low), float(r.close), float(r.volume)]
                            for t, r in base.iterrows()]))
    # the "1d" vs "1D" quirk: bars of real frames where the two thresholds disagree
    quirk = []
    for sym in all_symbols:
        df1h = load_candles(sym, "1h")
        for n in range(55, 401, 7):
            df = df1h.iloc[:n]
            a = market_regime.detect_regime(df, tf="1d")
            b = market_regime.detect_regime(df, tf="1D")
            if a != b:
                quirk.append(dict(symbol=sym, tf_src="1h", n=n, lower=a, upper=b))
        if len(quirk) >= 40:
            break
    return dict(cases=cases, quirk=quirk, thresholds=dict(market_regime._SLOPE_THRESH_BY_TF), baseline=market_regime._SLOPE_THRESH)


# ── stars ───────────────────────────────────────────────────────────────────────────────
def gen_stars():
    inputs = [None, 0, 1, 1.9, 2, 2.5, 3, 3.99, 4, 5, 5.5, 6, 7, 7.99, 8, 9, 10, 10.5, 11, 100, -3, -0.5,
              "7", "abc", "", True, False, 0.0, 9.999,
              "nan", "inf", "-inf", "+inf", "Infinity", "1e1", "  5 ", "0x5", "5_0", "1_0.5", "3.7", "-2", " 6_"]
    return [dict(input=conv(x) if not isinstance(x, str) else x, is_str=isinstance(x, str),
                 stars=quality_scale.levels_stars(x), text=quality_scale.stars_str(quality_scale.levels_stars(x)))
            for x in inputs] + [dict(input=n if not isinstance(n, str) else n, is_str=isinstance(n, str), stars=None, text=quality_scale.stars_str(n))
                        for n in (-1, 0, 2.9, 5, 6, None, True, "3", "2.9", " 4 ", "x", "1_0", 7.9, -0.5)]


# ── magnets ─────────────────────────────────────────────────────────────────────────────
def gen_magnets():
    rnd = random.Random(20261008)
    cases = []
    for _ in range(300):
        sl = rnd.choice([0.0001234, 0.0366, 1.2345, 97.5, 1234.5, 65000.0]) * (1 + rnd.uniform(-0.3, 0.3))
        direction = rnd.choice(["LONG", "SHORT"])
        k = rnd.randint(0, 6)
        magnets = [sl * (1 + rnd.uniform(-0.012, 0.012)) for _ in range(k)]
        if rnd.random() < 0.3 and magnets:
            magnets.append(sl)                                   # exact-boundary magnet
        if rnd.random() < 0.2:
            magnets.append(sl * (1 - 0.005))                     # exactly on the danger edge (LONG)
        if rnd.random() < 0.2:
            magnets.append(sl * (1 + 0.005))                     # exactly on the danger edge (SHORT)
        if rnd.random() < 0.1:
            magnets.append(0.0)                                  # dropped (> 0 filter)
        kw = {}
        if rnd.random() < 0.15:
            kw = dict(danger_zone_pct=rnd.choice([0.3, 1.0]), extension_buf_pct=rnd.choice([0.05, 0.2]), max_extension_pct=rnd.choice([0.2, 1.0]))
        new_sl, info = adjust_sl_for_magnets(sl, direction, magnets, **kw)
        cases.append(dict(sl=sl, direction=direction, magnets=magnets, kw=kw, new_sl=new_sl, info=conv(info)))
    for sl, direction, magnets in ((0.0, "LONG", [1.0]), (-1.0, "SHORT", [1.0]), (100.0, "LONG", []), (100.0, "LONG", None),
                                   (100.0, "SHORT", [99.0, 100.3, 100.49, 100.5, 100.51]), (100.0, "LONG", [99.5, 99.49, 99.51, 100.0])):
        new_sl, info = adjust_sl_for_magnets(sl, direction, magnets)
        cases.append(dict(sl=sl, direction=direction, magnets=magnets, kw={}, new_sl=new_sl, info=conv(info)))
    return cases


# ── coin classes ────────────────────────────────────────────────────────────────────────
def gen_coin_class():
    src = open(os.path.join(BOT, "indicator.py"), encoding="utf-8").read()
    m = re.search(r"_MEMCOIN_KW\s*=\s*\((.*?)\)", src, re.S)
    kw = tuple(s.strip().strip('"') for s in m.group(1).replace("\n", "").split(",") if s.strip())
    symbols = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "ETHFI-USDT-SWAP", "BTCDOM-USDT-SWAP", "PEPE-USDT-SWAP", "DOGE-USDT-SWAP",
               "PEPEVL07-USDT-SWAP", "DOGEVL08-USDT-SWAP", "SYNUP01-USDT-SWAP", "1000SATS-USDT-SWAP", "WIFETH-USDT-SWAP",
               "ACT-USDT-SWAP", "FACT-USDT-SWAP", "CATS-USDT-SWAP", "book-usdt-swap", "sol-usdt-swap", "MEMEBTC", "", "x"]
    rows = []
    for s in symbols:
        up = s.upper()
        rows.append(dict(symbol=s, memcoin=any(k in up for k in kw), major=("BTC" in up or "ETH" in up)))
    return dict(keywords=list(kw), rows=rows)


# ── relaxed-mode helpers ────────────────────────────────────────────────────────────────
def gen_relaxed():
    assert not md.is_relaxed_mode()
    off = dict(min_rr=[[x, md.relax_min_rr(x)] for x in (1.8, 2.0, 2.5, 3.0, 1.0, 5.0)],
               min_quality=[[x, md.relax_min_quality(x)] for x in (0, 1, 2, 3, 4, 5, 7, 10)])
    md.activate_relaxed("BTC", "test-reason", 2.5, 1.0)
    assert md.is_relaxed_mode()
    on = dict(min_rr=[[x, md.relax_min_rr(x)] for x in (1.8, 2.0, 2.5, 3.0, 1.0, 5.0)],
              min_quality=[[x, md.relax_min_quality(x)] for x in (0, 1, 2, 3, 4, 5, 7, 10)])
    md._state.relaxed = False
    md._state.relaxed_until = 0.0
    assert not md.is_relaxed_mode()
    return dict(off=off, on=on)


# ── ATR breakout ────────────────────────────────────────────────────────────────────────
def gen_atr_breakout(all_symbols):
    hits, misses = [], []
    for sym in all_symbols:
        df1h = load_candles(sym, "1h")
        for n in range(20, 401, 3):
            df = df1h.iloc[:n]
            md._last_breakout_alert.clear()
            br = md.detect_atr_breakout(sym, df)
            if br is not None:
                hits.append(dict(symbol=sym, n=n, result=conv(br)))
            elif len(misses) < 60:
                misses.append(dict(symbol=sym, n=n))
        if len(hits) >= 40:
            break
    # cooldown: a second call right after a hit returns None
    cooldown = None
    if hits:
        h = hits[0]
        df = load_candles(h["symbol"], "1h").iloc[:h["n"]]
        md._last_breakout_alert.clear()
        first = md.detect_atr_breakout(h["symbol"], df)
        second = md.detect_atr_breakout(h["symbol"], df)
        cooldown = dict(symbol=h["symbol"], n=h["n"], first_hit=first is not None, second_hit=second is not None)
    md._last_breakout_alert.clear()
    # the fallback SignalResult of analyze() in relaxed mode on breakout bars where _do_analyze is None
    ic = _cfg_to_ind(TradeCfg(), high_wr_mode=False)
    fallback = []
    md.activate_relaxed("BTC", "test-reason", 2.5, 1.0)
    try:
        for h in hits[:12]:
            df = load_candles(h["symbol"], "1h").iloc[:h["n"]]
            if len(df) < 200:
                continue
            ind = CHMIndicator(ic)
            indicator.reset_analyze_stats()
            plain = ind._do_analyze(h["symbol"], df, None, None, None, min_quality_override=None)
            md._last_breakout_alert.clear()
            ind = CHMIndicator(ic)
            indicator.reset_analyze_stats()
            sig = ind.analyze(h["symbol"], df, None, None, None)
            fallback.append(dict(symbol=h["symbol"], n=h["n"], do_analyze_none=plain is None,
                                 trigger_reason=md.get_state().trigger_reason,
                                 signal=conv(dataclasses.asdict(sig)) if sig is not None else None))
    finally:
        md._state.relaxed = False
        md._state.relaxed_until = 0.0
        md._last_breakout_alert.clear()
    return dict(hits=hits, misses=misses, cooldown=cooldown, fallback=fallback)


# ── part-2 locals of _do_analyze ────────────────────────────────────────────────────────
LOCAL_KEYS = ["entry", "sl", "_sl_before_lq", "_lq_info", "risk", "risk_pct_raw", "is_memcoin", "is_major",
              "_legacy_sl_dist", "_new_sl_dist", "_regime_mult",
              "stp1", "stp2", "stp3", "_tp_scale", "_tp1_mech_rr", "tp1", "tp2", "tp3",
              "rr_actual", "_effective_min_rr", "risk_pct", "rr_score",
              "corr_data", "diverg_ok", "diverg_label", "has_lvn_path", "htf_ok",
              "quality", "reasons", "checklist", "explanation", "_lf_enf", "_lf_shadow", "_hour"]


def gen_part2_locals(expected):
    out = []
    frames = {}

    def get(sym, tf):
        key = (sym, tf)
        if key not in frames:
            frames[key] = load_candles(sym, tf)
        return frames[key]

    captured = {}

    def prof(frame, event, arg):
        if event == "return" and frame.f_code.co_name == "_do_analyze" and frame.f_code.co_filename.endswith("indicator.py"):
            loc = frame.f_locals
            captured["locals"] = {k: loc[k] for k in LOCAL_KEYS if k in loc}

    for sym, per_variant in expected["fixtures"].items():
        df1h, df1d, btc, eth = get(sym, "1h"), get(sym, "1d"), get("BTC-USDT-SWAP", "1h"), get("ETH-USDT-SWAP", "1h")
        oms = df1h.index.values.astype("datetime64[ms]").astype("int64")
        for vname, fx in per_variant.items():
            v = expected["variants"][vname]
            ic = _cfg_to_ind(TradeCfg(**v["trade_cfg"]), high_wr_mode=v["high_wr_mode"])
            bars = sorted(set(fx["signal_bars"]) | {int(i) for i, r in fx["reject_reasons"].items() if r in LATE})
            for i in bars:
                df = df1h.iloc[:i + 1]
                close_ms = int(oms[i]) + TF_MS["1h"]
                df_htf = aligned_prefix(df1d, "1d", close_ms, 300) if ic.USE_HTF_FILTER else None
                ind = CHMIndicator(ic)
                indicator.reset_analyze_stats()
                captured.clear()
                sys.setprofile(prof)
                try:
                    sig = ind.analyze(sym, df, df_htf, btc.iloc[:i + 1], eth.iloc[:i + 1])
                finally:
                    sys.setprofile(None)
                st = indicator.get_analyze_stats()
                stage = "signal" if sig is not None else ",".join(sorted(st))
                want = "signal" if i in fx["signal_bars"] else fx["reject_reasons"][str(i)]
                assert stage == want, (sym, vname, i, stage, want)
                out.append(dict(symbol=sym, variant=vname, i=i, stage=stage, locals=conv(captured.get("locals", {}))))
    return out


def main():
    expected = load_expected_levels()
    all_symbols = list(expected["fixtures"].keys())
    doc = dict(
        note="generated by gen_part2.py with the bot's own code (see docstring); floats are repr round-trip exact",
        python=sys.version.split()[0], pandas=pd.__version__, numpy=np.__version__,
        regime=gen_regime(all_symbols),
        stars=gen_stars(),
        magnets=gen_magnets(),
        coin_class=gen_coin_class(),
        relaxed=gen_relaxed(),
        atr_breakout=gen_atr_breakout(all_symbols),
        part2_locals=gen_part2_locals(expected),
    )
    out = os.path.join(HERE, "part2_expected.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print("wrote", out, "regime cases", len(doc["regime"]["cases"]), "quirk", len(doc["regime"]["quirk"]),
          "magnets", len(doc["magnets"]), "breakout hits", len(doc["atr_breakout"]["hits"]),
          "fallback", len(doc["atr_breakout"]["fallback"]), "part2 bars", len(doc["part2_locals"]))


if __name__ == "__main__":
    main()
