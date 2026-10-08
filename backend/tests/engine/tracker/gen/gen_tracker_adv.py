"""gen_tracker_adv.py — adversarial vectors for the pure half of the bot's signal_tracker.py
(replay with exact level touches, unaligned progress_ts, odd stages and TFs; could_change;
levels_from_trade on legacy / string / NaN rows; mark_to_market_rr; missed_r at the
MISSED_R boundary; _fmt_r ties; _ago; build_text; outcome lines; _chart_df) for
backend/tests/engine/tracker/adv.test.js.

  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python gen_tracker_adv.py /abs/tracker_adv.json
  (afterwards: rm -f <bot>/signal_registry.json)
"""
from __future__ import annotations

import json
import math
import os
import random
import sys

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
os.chdir(BOT)
sys.path.insert(0, BOT)
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import signal_tracker as st  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else "tracker_adv.json"
rng = random.Random(81081)


def enc(v):
    """JSON-safe: NaN / ±inf as tagged strings (the JS test decodes them)."""
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return {"$f": "nan" if math.isnan(v) else ("inf" if v > 0 else "-inf")}
    if isinstance(v, dict):
        return {k: enc(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [enc(x) for x in v]
    return v


def L_dict(L):
    return {"direction": L.direction, "entry": L.entry, "sl": L.sl, "tp1": L.tp1, "tp2": L.tp2,
            "tp3": L.tp3, "needs_fill": L.needs_fill, "fill_lo": L.fill_lo, "fill_hi": L.fill_hi}


def call(fn, *a, **kw):
    try:
        return {"ok": fn(*a, **kw)}
    except Exception as e:  # noqa: BLE001
        return {"raise": type(e).__name__, "msg": str(e)}


out: dict = {}

# ── A. replay with exact touches ────────────────────────────────────────────
STAGES = ["", "", "", "ENTRY", "TP1", "TP2", "TP3", "SL", "BE", "EXPIRED", "MISSED", "tp1", "entry", "XX"]
out["replay"] = []
for k in range(150):
    d = rng.choice(["LONG", "SHORT", "long", "Short"])
    up = d.upper() == "LONG"
    s = 1.0 if up else -1.0
    entry = rng.choice([100.0, 1.0, 0.5, 65000.0, 0.0001234, 3.0])
    risk = entry * rng.choice([0.01, 0.02, 0.005, 0.25])
    tr = {"direction": d, "entry": entry, "sl": entry - s * risk, "tp1": entry + s * risk,
          "tp2": entry + 2 * s * risk, "tp3": entry + 3 * s * risk}
    if rng.random() < 0.15:
        tr["tp2"] = tr["tp1"]               # equal TPs
    if rng.random() < 0.1:
        tr["tp3"] = 0.0
    if rng.random() < 0.1:
        tr["tp2"] = 0.0
    if rng.random() < 0.4:
        tr["entry_lo"] = entry - 0.5 * risk
        tr["entry_hi"] = entry + 0.5 * risk
        if rng.random() < 0.3:
            tr["entry_lo"], tr["entry_hi"] = tr["entry_hi"], tr["entry_lo"]
        if rng.random() < 0.1:
            tr["entry_hi"] = tr["entry_lo"]  # degenerate zone → market entry
    L = st.levels_from_trade(tr)
    grid = [L.sl, L.entry, L.tp1, L.tp2, L.tp3, L.fill_lo, L.fill_hi]
    tf = rng.choice([300, 900, 3600, 14400])
    created = 1_700_000_000.0 + rng.choice([0.0, 0.5, 299.0, tf * 1.0, tf - 0.001])
    n = rng.randint(0, 12)
    bars = []
    t0 = 1_700_000_000.0 - 2 * tf
    for i in range(n):
        t = t0 + i * tf
        if rng.random() < 0.08 and bars:
            t = bars[-1][0]                 # duplicate open time
        a = rng.choice(grid + [entry + s * risk * rng.uniform(-1.5, 3.5)])
        b = rng.choice(grid + [entry + s * risk * rng.uniform(-1.5, 3.5)])
        hi, lo = max(a, b), min(a, b)
        if rng.random() < 0.05:
            hi, lo = lo, hi                 # inverted bar
        bars.append((t, hi, lo))
    stage0 = rng.choice(STAGES)
    pts = rng.choice([0.0, created, created + 1.0, t0 + rng.randint(0, 12) * tf,
                      t0 + rng.randint(0, 12) * tf + rng.uniform(0, tf), created - tf])
    stage, pts2, ev = st.replay(L, bars, stage0, pts, created, tf)
    hmax = max([b[1] for b in bars], default=0.0)
    lmin = min([b[2] for b in bars], default=0.0)
    cc = {}
    for stg in ["", "ENTRY", "TP1", "TP2", "TP3", "SL", "tp1"]:
        cc[stg] = st.could_change(L, stg, hmax, lmin)
        cc[stg + "@grid"] = [st.could_change(L, stg, g1, g2) for g1 in grid[:5] for g2 in grid[:5]]
    out["replay"].append({"trade": tr, "levels": L_dict(L), "bars": bars, "stage0": stage0, "pts": pts,
                          "created": created, "tf": tf, "stage": stage, "pts2": pts2, "events": ev,
                          "hmax": hmax, "lmin": lmin, "could_change": cc})

# ── B. levels_from_trade / valid / risk / r_of / mark_to_market_rr on odd rows ──
ODD = [None, 0, 0.0, -1.0, "", "abc", "nan", "inf", "-inf", "1e3", " 101.5 ", "1_000", True, 5, 100, 99.5, 101.0]
out["levels"] = []
for k in range(220):
    tr = {}
    for key in ["direction", "entry", "sl", "original_sl", "tp1", "tp2", "tp3", "entry_lo", "entry_hi"]:
        if rng.random() < 0.8:
            if key == "direction":
                tr[key] = rng.choice(["LONG", "SHORT", "long", None, "", "sideways", 0])
            elif rng.random() < 0.6:
                base = 100.0
                tr[key] = {"entry": base, "sl": rng.choice([95.0, 105.0, 100.0]),
                           "original_sl": rng.choice([94.0, 106.0, 0.0, None]),
                           "tp1": rng.choice([110.0, 90.0]), "tp2": rng.choice([120.0, 80.0]),
                           "tp3": rng.choice([130.0, 70.0, 0.0]),
                           "entry_lo": rng.choice([99.0, 101.0, 0.0]), "entry_hi": rng.choice([101.0, 99.0, 0.0])}[key]
            else:
                tr[key] = rng.choice(ODD)
    L = call(st.levels_from_trade, tr)
    rec = {"trade": tr, "levels": None, "raise": None}
    if "ok" in L:
        LL = L["ok"]
        rec["levels"] = L_dict(LL)
        rec["valid"] = call(LL.valid)
        rec["risk"] = call(LL.risk)
        rec["r_of"] = [call(LL.r_of, p) for p in (0.0, -1.0, 100.0, 112.5, 87.5)]
    else:
        rec["raise"] = L
    prices = [100.0, 115.0, 85.0, 1000.0, 0.0, None, -5.0, 130.0, 70.0, "101", float("nan")]
    rec["mtm"] = [call(st.mark_to_market_rr, tr, p) for p in prices]
    out["levels"].append(rec)

# ── C. missed_r around the MISSED_R boundary ────────────────────────────────
out["missed"] = []
for k in range(150):
    d = rng.choice(["LONG", "SHORT"])
    s = 1.0 if d == "LONG" else -1.0
    entry = rng.choice([100.0, 0.5, 1.0])
    risk = entry * rng.choice([0.01, 0.02, 0.1])
    tr = {"direction": d, "entry": entry, "sl": entry - s * risk, "tp1": entry + s * risk,
          "tp2": entry + 2 * s * risk, "tp3": entry + 3 * s * risk}
    if rng.random() < 0.8:
        tr["entry_lo"] = entry - 0.25 * risk
        tr["entry_hi"] = entry + 0.25 * risk
    L = st.levels_from_trade(tr)
    n = rng.randint(1, 6)
    highs = [entry + s * risk * rng.choice([0.25, 0.26, 0.5, 1.0, 2.0, -0.3]) for _ in range(n)]
    lows = [entry + s * risk * rng.choice([0.25, 0.26, 0.5, 1.0, 2.0, -0.3]) for _ in range(n)]
    if d == "SHORT":
        highs, lows = lows, highs
    close = entry + s * risk * rng.choice([1.0, 0.999, 1.001, 2.345, 0.5, -1.0, 1.005, 1.015])
    if rng.random() < 0.05:
        close = 0.0
    r = st.missed_r(L, np.array(highs), np.array(lows), close)
    out["missed"].append({"trade": tr, "highs": highs, "lows": lows, "close": close, "r": r})

# ── D. text helpers ─────────────────────────────────────────────────────────
out["fmt_r"] = [[x, st._fmt_r(x)] for x in
                [0.0, 1.0, 1.25, 2.25, 0.05, 0.15, 0.25, 0.35, 2.5, 3.5, 1.05, 1.95, 1.9999999999, 2.00000000001,
                 0.45, 0.55, 10.25, 0.0499999, 2.6500000000000004, -0.25, -1.5, 1e-10, 7.75] +
                [rng.uniform(0, 6) for _ in range(40)] + [round(rng.uniform(0, 6), 2) for _ in range(40)]]
out["ago"] = [[x, lang, st._ago(x, lang)] for x in
              [0, 59.9, 60, 61, 3599, 3600, 3661, 86399, 86400, 90061, 172800, -5, -61, 1e7, 123.456, 59.99999999]
              + [rng.uniform(-100, 400000) for _ in range(30)] for lang in ("ru", "en")]
out["fmt_outcome"] = [[x, st._fmt_outcome_r(x)] for x in
                      [None, 0.0, -0.0, 0.04, -0.04, 0.05, -0.05, 0.15, 0.25, -1.0, 2.25, 1.35, 3.45, 0.95, 10.0, -0.049]]
out["texts"] = []
for k in range(60):
    tr = {"symbol": rng.choice(["BTC-USDT-SWAP", "ETH-USDT", "<b>X</b>-USDT-SWAP", "", None, "PEPE-USDT-SWAP-USDT"]),
          "strategy": rng.choice(["levels", "SMC", "", None, "v&lume"]),
          "timeframe": rng.choice(["15m", "", None, "1h", "<4h>"]),
          "created_at": rng.choice([0, None, 1_700_000_000.0, 1_700_000_000.5]),
          "direction": rng.choice(["LONG", "SHORT"])}
    s = 1.0 if tr["direction"] == "LONG" else -1.0
    entry = rng.choice([100.0, 0.000123, 65000.5, 1.23456789])
    risk = entry * rng.choice([0.01, 0.0123, 0.2])
    tr.update({"entry": entry, "sl": entry - s * risk, "tp1": entry + s * risk * rng.choice([1.0, 1.25, 1.5]),
               "tp2": entry + s * risk * rng.choice([2.0, 2.25]), "tp3": entry + s * risk * rng.choice([3.0, 3.75])})
    L = st.levels_from_trade(tr)
    event = rng.choice(["TP1", "TP2", "TP3", "SL", "BE", "ENTRY", "<x>"])
    hit = rng.choice([[], ["TP1"], ["TP1", "TP2"], ["TP1", "TP2", "TP3"], ["TP1", "SL"], ["TP2"]])
    lang = rng.choice(["ru", "en", None, "de"])
    now = rng.choice([1_700_000_000.0 + rng.uniform(0, 300000), 1_700_003_661.0])
    out["texts"].append({"trade": tr, "levels": L_dict(L), "event": event, "hit": hit, "lang": lang, "now": now,
                         "text": st.build_text(tr, L, event, hit, lang=lang, now=now)})
out["outcome_lines"] = [[stg, rr, lang, st.outcome_line(stg, rr, lang)]
                        for stg in ["TP1", "TP2", "TP3", "SL", "BE", "EXPIRED", "MISSED", "ENTRY", "", "toString"]
                        for rr in [None, 1.25, -1.0, 0.0] for lang in ["ru", "en", "de", None]]
out["card_texts"] = [[h, ln, st.card_text_with_outcome(h, ln)] for h in
                     ["<b>x</b>", "a  \n\t ", "a\n\n📌 old", "a\n\n📌 one\n\n📌 two", "", "  ", "x​", "y﻿",
                      "z\u001c", "w\u0085", "\n\n📌 ", "q　"] for ln in ["L", ""]]

# ── E. chart window ─────────────────────────────────────────────────────────
out["chart"] = []
for k in range(60):
    tf = rng.choice([900, 3600])
    n = rng.randint(1, 260)
    t0 = 1_700_000_000.0
    idx = pd.to_datetime([int((t0 + i * tf) * 1000) for i in range(n)], unit="ms")
    df = pd.DataFrame({"open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 1.0}, index=idx)
    created = t0 + rng.choice([0, 10, 45, 100, 200, 259, 300]) * tf + rng.choice([0.0, 0.5])
    w = st._chart_df(df, created, tf)
    out["chart"].append({"n": n, "t0": t0, "tf": tf, "created": created, "len": int(len(w)),
                         "first": float((w.index[0] - pd.Timestamp(0)).total_seconds())})

json.dump(enc(out), open(OUT, "w"), ensure_ascii=False)
print({k: len(v) for k, v in out.items()})
sys.stdout.flush()
os._exit(0)
