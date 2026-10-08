"""gen_tracker_vectors.py — real outputs of the bot's signal_tracker.py pure functions
(and process_trade / update_signal_card / mark_missed / expire_stale / run_cycle driven with
fakes for the DB, cache, REST, price, users and the Telegram bot) for the JS parity tests in
backend/tests/engine/tracker/*.test.js. Candles: backend/tests/golden/candles.

Run with the bot's venv (the script chdirs into the bot checkout itself; OUT must be absolute):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python gen_tracker_vectors.py /abs/OUT.json
  (afterwards: rm -f <bot>/signal_registry.json)
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import sys
from types import SimpleNamespace

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
os.chdir(BOT)
sys.path.insert(0, BOT)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import signal_tracker as st  # noqa: E402
from db.signal_outcome import signal_rr  # noqa: E402

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "golden", "candles")
OUT = sys.argv[1] if len(sys.argv) > 1 else "tracker_vectors.json"

# capture the tracker's INFO / WARNING log lines (the [SIGNAL-PROGRESS*] grep contract)
import logging  # noqa: E402
LOG_LINES: list = []


class _Cap(logging.Handler):
    def emit(self, record):
        if record.levelno >= logging.INFO:
            LOG_LINES.append(record.getMessage())


logging.getLogger("CHM.SignalTracker").addHandler(_Cap())
logging.getLogger("CHM.SignalTracker").setLevel(logging.INFO)


def load_df(symbol: str, tf: str) -> pd.DataFrame:
    fx = json.load(open(f"{GOLDEN}/{symbol}_{tf}.json"))
    df = pd.DataFrame(fx["bars"], columns=["open_time", "open", "high", "low", "close", "volume"]).astype(float)
    df.index = pd.to_datetime(df["open_time"].astype("int64"), unit="ms")
    df.index.name = "open_time"
    return df.drop(columns=["open_time"])


def L_dict(L: st.Levels) -> dict:
    return {"direction": L.direction, "entry": L.entry, "sl": L.sl, "tp1": L.tp1, "tp2": L.tp2,
            "tp3": L.tp3, "needs_fill": L.needs_fill, "fill_lo": L.fill_lo, "fill_hi": L.fill_hi}


out: dict = {"constants": {
    "INTERVAL_S": st.INTERVAL_S, "MAX_AGE_H": st.MAX_AGE_H, "SEND_DELAY_S": st.SEND_DELAY_S,
    "REST_PER_CYCLE": st.REST_PER_CYCLE, "MAX_ROWS": st.MAX_ROWS, "MAX_EVENT_LAG_H": st.MAX_EVENT_LAG_H,
    "MISSED_R": st.MISSED_R, "MISSED_MIN_AGE_S": st.MISSED_MIN_AGE_S, "FINAL": sorted(st.FINAL),
    "TF_SEC": st._TF_SEC, "TF_NORM": st._TF_NORM, "CARD_MARK": st._CARD_MARK,
    "CARD_MAX_JSON": st._CARD_MAX_JSON, "CARD_MAX_TEXT": st._CARD_MAX_TEXT, "OUTCOME_LINE": st._OUTCOME_LINE,
}}

# ── 1. named replay table (spec §11.5) ──────────────────────────────────────
LONG = dict(direction="LONG", entry=100.0, sl=95.0, tp1=110.0, tp2=120.0, tp3=130.0)
SHORT = dict(direction="SHORT", entry=100.0, sl=105.0, tp1=90.0, tp2=80.0, tp3=70.0)
ZONE_L = dict(direction="LONG", entry=100.0, sl=95.0, tp1=110.0, tp2=120.0, tp3=130.0, entry_lo=99.0, entry_hi=101.0)
ZONE_S = dict(direction="SHORT", entry=100.0, sl=105.0, tp1=90.0, tp2=80.0, tp3=70.0, entry_lo=99.0, entry_hi=101.0)
TF = 900
C = 1000.0   # created_at
named = [
    ("fill bar SL-only (zone touched + SL in the same bar; TP never)", ZONE_L, [(C + TF, 112.0, 94.0)], "", 0.0),
    ("fill bar touches zone and TP1 — only ENTRY", ZONE_L, [(C + TF, 112.0, 100.5)], "", 0.0),
    ("zone LONG not touched", ZONE_L, [(C + TF, 112.0, 101.5)], "", 0.0),
    ("zone SHORT touched then TP1 next bar", ZONE_S, [(C + TF, 99.5, 97.0), (C + 2 * TF, 95.0, 89.0)], "", 0.0),
    ("SL-first when SL and TP1 touched in one bar", LONG, [(C + TF, 111.0, 94.0)], "", 0.0),
    ("TP1 never in the partial (transition) bar", LONG, [(C + TF, 111.0, 99.0)], "ENTRY", C + TF),
    ("TP1 then TP2 in the same bar", LONG, [(C + TF, 121.0, 99.0)], "", 0.0),
    ("TP1, TP2, TP3 in one bar", LONG, [(C + TF, 135.0, 99.0)], "", 0.0),
    ("BE after TP1 (next bar returns to entry)", LONG, [(C + TF, 111.0, 99.0), (C + 2 * TF, 105.0, 100.0)], "", 0.0),
    ("no BE in the bar that gave TP1 (just_hit)", LONG, [(C + TF, 111.0, 95.5)], "", 0.0),
    ("TP2 and entry touched after TP1 — TP first", LONG, [(C + TF, 121.0, 99.0)], "TP1", C),
    ("transition bar revisited: TP2 continuation allowed, BE not (full=False)", LONG, [(C + TF, 121.0, 99.0)], "TP1", C + TF),
    ("transition bar revisited: entry touched only — nothing", LONG, [(C + TF, 105.0, 99.0)], "TP1", C + TF),
    ("bars at/before created_at are skipped", LONG, [(C - TF, 150.0, 50.0), (C, 150.0, 50.0), (C + TF, 111.0, 99.0)], "", 0.0),
    ("bars fully before progress_ts are skipped", LONG, [(C - 2 * TF, 150.0, 50.0), (C + TF, 111.0, 99.5)], "TP1", C),
    ("FINAL stage breaks immediately", LONG, [(C + TF, 150.0, 50.0)], "SL", C),
    ("SHORT: SL-first", SHORT, [(C + TF, 106.0, 89.0)], "", 0.0),
    ("SHORT: TP1→TP2, then BE", SHORT, [(C + TF, 101.0, 79.0), (C + 2 * TF, 100.0, 85.0)], "", 0.0),
    ("SHORT after TP2: TP3 and BE in next bar — TP wins", SHORT, [(C + TF, 100.5, 69.0)], "TP2", C),
    ("multi-bar path TP1 → BE then nothing", LONG, [(C + TF, 111.0, 99.0), (C + 2 * TF, 108.0, 101.0), (C + 3 * TF, 109.0, 99.0), (C + 4 * TF, 200.0, 1.0)], "", 0.0),
]
out["named"] = []
for name, tr, bars, stage0, pts in named:
    L = st.levels_from_trade(tr)
    stage, pts2, ev = st.replay(L, bars, stage0, pts, C, TF)
    out["named"].append({"name": name, "trade": tr, "bars": bars, "stage0": stage0, "progress_ts": pts,
                         "created_at": C, "tf_sec": TF, "levels": L_dict(L), "valid": L.valid(),
                         "stage": stage, "pts": pts2, "events": ev})

# ── 2. random replay + could_change ─────────────────────────────────────────
rng = random.Random(10)
out["random"] = []
for k in range(400):
    direction = rng.choice(["LONG", "SHORT"])
    entry = rng.choice([100.0, 0.0123, 65000.5, 1.5])
    risk = entry * rng.uniform(0.005, 0.03)
    sgn = 1 if direction == "LONG" else -1
    r1, r2, r3 = rng.uniform(1.0, 2.5), rng.uniform(2.6, 4.0), rng.uniform(4.1, 6.0)
    tr = {"direction": direction, "entry": entry, "sl": entry - sgn * risk,
          "tp1": entry + sgn * r1 * risk, "tp2": entry + sgn * r2 * risk, "tp3": entry + sgn * r3 * risk}
    if rng.random() < 0.4:
        tr["entry_lo"] = entry - rng.uniform(0.1, 0.5) * risk
        tr["entry_hi"] = entry + rng.uniform(0.1, 0.5) * risk
        if rng.random() < 0.2:
            tr["entry_lo"], tr["entry_hi"] = tr["entry_hi"], tr["entry_lo"]
    if rng.random() < 0.3:
        tr["original_sl"] = tr["sl"] + sgn * risk * rng.uniform(-0.3, 0.3) * 0.5
    if rng.random() < 0.05:
        tr["original_sl"] = 0
    tf = rng.choice([900, 3600])
    created = 1_700_000_000.0 + rng.randint(0, 10) * tf
    n = rng.randint(1, 14)
    price = entry
    bars = []
    for i in range(-2, n):
        t = created + i * tf
        mv = rng.gauss(0, 1.2) * risk
        hi = price + abs(mv) + rng.uniform(0, 1.5) * risk
        lo = price - abs(mv) - rng.uniform(0, 1.5) * risk
        price = price + mv
        close = rng.uniform(lo, hi)
        bars.append((t, hi, lo, close))
    stage0 = rng.choice(["", "", "", "ENTRY", "TP1", "TP2", "SL", "TP3"])
    pts = 0.0 if stage0 == "" else created + rng.randint(0, max(0, n - 1)) * tf
    L = st.levels_from_trade(tr)
    stage, pts2, ev = st.replay(L, [(b[0], b[1], b[2]) for b in bars], stage0, pts, created, tf)
    _t = np.array([b[0] for b in bars]); _h = np.array([b[1] for b in bars]); _l = np.array([b[2] for b in bars])
    m = (_t > created) if stage0 == "" else (_t + tf > pts)
    cc = bool(m.any()) and st.could_change(L, stage0, float(_h[m].max()), float(_l[m].min()))
    highs = _h[_t > created]; lows = _l[_t > created]
    missed = st.missed_r(L, highs, lows, float(bars[-1][3])) if len(highs) else None
    out["random"].append({"trade": tr, "bars": bars, "stage0": stage0, "progress_ts": pts, "created_at": created,
                          "tf_sec": tf, "levels": L_dict(L), "valid": L.valid(), "stage": stage, "pts": pts2,
                          "events": ev, "could_change": cc, "any_mask": bool(m.any()), "missed_r": missed,
                          "mtm": {str(p): st.mark_to_market_rr(tr, p) for p in (entry, entry + 3 * sgn * risk, entry - 3 * sgn * risk, entry + 20 * sgn * risk, 0, None)}})

# ── 3. small helpers ────────────────────────────────────────────────────────
out["pick_tfs"] = {str(a): list(st._pick_tfs(a)) for a in (0, 3600, 20 * 3600, 20 * 3600 + 1, 70 * 3600, 70 * 3600 + 0.5, 100 * 3600)}
out["fmt_r"] = {str(r): st._fmt_r(r) for r in (0, 1, 1.5, 2.0, 2.33, 2.35, 2.45, 2.5, 3.5, 0.05, 0.04, 1.96, 2.999999999, 10.25, 0.1 + 0.2)}
out["ago"] = {f"{s}|{lang}": st._ago(s, lang) for s in (0, 30, 59, 60, 61, 3599, 3600, 3725, 86399, 86400, 90000, 2 * 86400 + 3600 * 5 + 60 * 7, -30, 120.9) for lang in ("ru", "en")}
out["fmt_outcome_r"] = {str(v): st._fmt_outcome_r(v) for v in (None, 0, 0.0, -0.0, 0.04, -0.04, 0.05, -0.05, 2.0, -1.0, 2.25, 2.35, -2.35, 10.0)}
out["outcome_line"] = [{"stage": s, "rr": rr, "lang": lang, "line": st.outcome_line(s, rr, lang)}
                       for s in ("TP1", "TP2", "TP3", "SL", "BE", "EXPIRED", "MISSED", "ENTRY", "")
                       for rr in (None, 2.0, -1.0, 0.0, 1.37) for lang in ("ru", "en", "de")]
out["card_text"] = [{"html": h, "line": ln, "text": st.card_text_with_outcome(h, ln)} for h, ln in (
    ("<b>card</b>\n\nbody", "🎯 TP1 достигнут · +2.0R (стоп → безубыток)"),
    ("<b>card</b>\n\nbody\n\n📌 old line", "❌ Стоп · -1.0R"),
    ("<b>card</b>  \n\n📌 old\n\n📌 older", "x"),
    ("card\n \t\n", "y"),
    ("", "z"),
)]

# build_text snapshots
trade = {"symbol": "BTC-USDT-SWAP", "strategy": "levels", "timeframe": "1h", "created_at": 1_700_000_000.0}
Lb = st.levels_from_trade({**trade, **LONG})
Ls = st.levels_from_trade({"direction": "SHORT", "entry": 0.012345, "sl": 0.0130, "tp1": 0.0110, "tp2": 0.0100, "tp3": 0.0090})
out["build_text"] = []
for ev, hit in (("TP1", ["TP1"]), ("TP2", ["TP1", "TP2"]), ("TP3", ["TP1", "TP2", "TP3"]), ("SL", []), ("BE", ["TP1"]), ("BE", ["TP1", "TP2"]), ("BE", []), ("ENTRY", []), ("WEIRD<>&", ["TP1"])):
    for lang in ("ru", "en", "fr"):
        for name, L, tr in (("btc", Lb, trade), ("pepe", Ls, {"symbol": "PEPE-USDT", "strategy": "", "timeframe": "", "created_at": 0}),
                            ("smc", Lb, {"symbol": "X<&>-USDT-SWAP", "strategy": "SMC", "timeframe": "15m", "created_at": 1_700_000_000.0})):
            out["build_text"].append({"case": name, "event": ev, "hit": hit, "lang": lang, "trade": tr, "levels": L_dict(L),
                                      "now": 1_700_000_000.0 + 3725.0,
                                      "text": st.build_text(tr, L, ev, hit, lang=lang, now=1_700_000_000.0 + 3725.0)})

# levels_from_trade coercions
out["levels_from_trade"] = []
for tr in (
    {"direction": "long", "entry": "100", "sl": "95", "tp1": 110, "tp2": None, "tp3": ""},
    {"direction": None, "entry": 100, "sl": 95, "original_sl": 96, "tp1": 110},
    {"direction": "SHORT", "entry": 100, "sl": 105, "original_sl": 0, "tp1": 90},
    {"direction": "SHORT", "entry": 100, "sl": 105, "original_sl": None, "tp1": 90, "entry_lo": 101, "entry_hi": 99},
    {"direction": "LONG", "entry": 100, "sl": 95, "original_sl": "abc", "tp1": 110},
    {"direction": "LONG", "entry": 100, "sl": 95, "tp1": 110, "entry_lo": 100, "entry_hi": 100},
    {"direction": "LONG", "entry": 100, "sl": 95, "tp1": 110, "entry_lo": 0, "entry_hi": 101},
    {"direction": "LONG", "entry": 0, "sl": 95, "tp1": 110},
    {"direction": "LONG", "entry": 100, "sl": 100, "tp1": 110},
    {"direction": "LONG", "entry": 100, "sl": 95, "tp1": 100},
    {"direction": "SHORT", "entry": 100, "sl": 95, "tp1": 90},
    {},
):
    L = st.levels_from_trade(tr)
    out["levels_from_trade"].append({"trade": tr, "levels": L_dict(L), "valid": L.valid(), "risk": L.risk(),
                                     "r_of": [L.r_of(p) for p in (0, 100, 110, 90, 123.4)]})

# missed_r table
out["missed_r"] = []
for tr, highs, lows, close in (
    (ZONE_L, [104, 106], [102, 103], 106.0),        # never touched zone, ran 1.2R → 1.2
    (ZONE_L, [104, 106], [100.9, 103], 106.0),      # touched → None
    (ZONE_L, [103, 104], [102, 103], 104.0),        # 0.8R < 1 → None
    (LONG, [104, 106], [102, 103], 106.0),          # market entry → None
    (ZONE_S, [98, 97], [96, 94], 94.0),             # short ran 1.2R → 1.2
    (ZONE_S, [99.5, 97], [96, 94], 94.0),           # touched (fill_lo=99) → None
    (ZONE_S, [98, 97], [96, 94], 0.0),              # close 0 → None
    (ZONE_L, [], [], 106.0),                        # empty → None
    (ZONE_L, [104, 106.7], [102, 103], 106.123456), # rounding
):
    L = st.levels_from_trade(tr)
    out["missed_r"].append({"trade": tr, "highs": highs, "lows": lows, "close": close,
                            "r": st.missed_r(L, np.array(highs, dtype=float), np.array(lows, dtype=float), close)})

# mark_to_market_rr table
out["mtm"] = []
for tr, price in (
    (LONG, 102.5), (LONG, 90.0), (LONG, 200.0), (LONG, 130.0), (SHORT, 97.5), (SHORT, 120.0), (SHORT, 50.0),
    ({**LONG, "tp3": 0}, 200.0), ({**LONG, "original_sl": 97.5}, 102.5), ({**LONG, "original_sl": None}, 102.5),
    ({**LONG, "entry": 0}, 102.5), ({**LONG, "sl": 100}, 102.5), (LONG, 0), (LONG, None), (LONG, "101.234"),
    ({**LONG, "direction": None}, 103.3333), ({"direction": "LONG", "entry": "x", "sl": 95}, 100),
):
    out["mtm"].append({"trade": tr, "price": price, "rr": st.mark_to_market_rr(tr, price)})

# _chart_df window sizes
out["chart_window"] = []
for n_bars, created_off, tf in ((10, 0, 900), (100, 50 * 900, 900), (300, 250 * 900, 900), (300, 10 * 900, 900), (50, 45 * 3600, 3600)):
    idx = pd.date_range("2026-01-01", periods=n_bars, freq=f"{tf}s")
    df = pd.DataFrame({"high": 1.0, "low": 1.0, "close": 1.0}, index=idx)
    created = float(idx[0].timestamp()) + created_off
    out["chart_window"].append({"n_bars": n_bars, "created_at": created, "tf_sec": tf, "keep": len(st._chart_df(df, created, tf))})

# ── 4. update_signal_card with a fake bot (pure part) ───────────────────────
class _Forbidden(Exception):
    pass
_Forbidden.__name__ = "TelegramForbiddenError"


def make_bot(mode="ok"):
    calls = []

    async def edit_message_text(**kw):
        calls.append(kw)
        if mode == "not_modified":
            raise RuntimeError("Bad Request: message is not modified")
        if mode == "forbidden":
            raise _Forbidden("Forbidden: bot was blocked by the user")
        if mode == "deactivated":
            raise RuntimeError("user is deactivated")
        if mode == "error":
            raise RuntimeError("boom")
    return SimpleNamespace(edit_message_text=edit_message_text), calls


card = json.dumps({"html": "<b>BTC LONG</b>\nвход 100\n", "kb": {"inline_keyboard": [[{"text": "x", "callback_data": "y"}]]}}, ensure_ascii=False)
base_tr = {"trade_id": "t1", "signal_msg_id": 55, "user_id": 7, "signal_card_json": card, **LONG, "original_sl": 96.0, "expire_rr": 1.23}
cases = [
    ("tp2", {**base_tr}, "TP2", "ru", "ok"),
    ("tp1 en", {**base_tr}, "TP1", "en", "ok"),
    ("tp3 de→ru", {**base_tr}, "TP3", "de", "ok"),
    ("sl", {**base_tr}, "SL", "ru", "ok"),
    ("be", {**base_tr}, "BE", "ru", "ok"),
    ("expired", {**base_tr}, "EXPIRED", "ru", "ok"),
    ("expired none", {**base_tr, "expire_rr": None}, "EXPIRED", "en", "ok"),
    ("missed", {**base_tr, "missed_rr": 1.37}, "MISSED", "ru", "ok"),
    ("missed en no rr", {**base_tr}, "MISSED", "en", "ok"),
    ("entry skip", {**base_tr}, "ENTRY", "ru", "ok"),
    ("no mid", {**base_tr, "signal_msg_id": 0}, "TP1", "ru", "ok"),
    ("mid str", {**base_tr, "signal_msg_id": "56"}, "TP1", "ru", "ok"),
    ("mid bad", {**base_tr, "signal_msg_id": "x"}, "TP1", "ru", "ok"),
    ("no uid", {**base_tr, "user_id": None}, "TP1", "ru", "ok"),
    ("no card", {**base_tr, "signal_card_json": ""}, "TP1", "ru", "ok"),
    ("bad json", {**base_tr, "signal_card_json": "{nope"}, "TP1", "ru", "ok"),
    ("empty html", {**base_tr, "signal_card_json": json.dumps({"html": ""})}, "TP1", "ru", "ok"),
    ("old mark replaced", {**base_tr, "signal_card_json": json.dumps({"html": "<b>c</b>\n\n📌 🎯 TP1 достигнут · +2.0R"})}, "TP2", "ru", "ok"),
    ("too long", {**base_tr, "signal_card_json": json.dumps({"html": "я" * 3990})}, "TP1", "ru", "ok"),
    ("just fits", {**base_tr, "signal_card_json": json.dumps({"html": "я" * 3955})}, "TP1", "ru", "ok"),
    ("not modified", {**base_tr}, "TP1", "ru", "not_modified"),
    ("forbidden", {**base_tr}, "TP1", "ru", "forbidden"),
    ("deactivated", {**base_tr}, "TP1", "ru", "deactivated"),
    ("error", {**base_tr}, "TP1", "ru", "error"),
    ("result ignored, stage used", {**base_tr, "result": "SL", "result_rr": -1.0}, "TP2", "ru", "ok"),
    ("card is a list", {**base_tr, "signal_card_json": "[1, 2]"}, "TP1", "ru", "ok"),
    ("card is null", {**base_tr, "signal_card_json": "null"}, "TP1", "ru", "ok"),
    ("card is a number", {**base_tr, "signal_card_json": "5"}, "TP1", "ru", "ok"),
    ("card is a string", {**base_tr, "signal_card_json": "\"<b>x</b>\""}, "TP1", "ru", "ok"),
    ("html is a number", {**base_tr, "signal_card_json": json.dumps({"html": 5})}, "SL", "ru", "ok"),
    ("uid str", {**base_tr, "user_id": "7"}, "SL", "en", "ok"),
    ("uid bad", {**base_tr, "user_id": "u7"}, "SL", "en", "ok"),
    ("unknown stage", {**base_tr}, "WEIRD", "ru", "ok"),
    ("prototype-ish stage", {**base_tr}, "toString", "ru", "ok"),
    ("trailing unicode ws", {**base_tr, "signal_card_json": json.dumps({"html": "<b>x</b> \t\n  "})}, "BE", "ru", "ok"),
    ("bom is not whitespace", {**base_tr, "signal_card_json": json.dumps({"html": "<b>x</b>﻿"})}, "BE", "ru", "ok"),
    ("x1c is whitespace", {**base_tr, "signal_card_json": json.dumps({"html": "<b>x</b>\x1c\x1f\x85"})}, "BE", "ru", "ok"),
]
out["update_card"] = []
for name, tr, stage, lang, mode in cases:
    bot, calls = make_bot(mode)
    res = asyncio.run(st.update_signal_card(bot, tr, stage, lang))
    rr = tr.get("missed_rr") if stage == "MISSED" else signal_rr({**tr, "progress_stage": stage, "result": ""}, stage.lower())
    out["update_card"].append({"name": name, "trade": tr, "stage": stage, "lang": lang, "mode": mode, "result": res,
                               "rr": rr, "line": st.outcome_line(stage, rr, lang),
                               "text": calls[0]["text"] if calls else None,
                               "text_len": len(calls[0]["text"]) if calls else None})

# ── 5. process_trade on golden candles with fakes ───────────────────────────
import db.signal_progress as sp  # noqa: E402

df15 = load_df("BTC-USDT-SWAP", "15m")
df1h = load_df("BTC-USDT-SWAP", "1h")
bars15 = st.bars_from_df(df15)


class FakeSrc(st._CandleSource):
    def __init__(self, frames: dict, rest_budget: int = 20):
        super().__init__(fetcher=None, rest_budget=rest_budget)
        self.frames = frames
        self.calls = []

    async def get(self, symbol, tf, need_from):
        self.calls.append([symbol, tf, need_from])
        df = self.frames.get(tf)
        return df if st._covers(df, need_from) else None


advanced = []


async def fake_advance(trade_id, expected, new, pts):
    advanced.append([trade_id, expected, new, pts])
    return not trade_id.endswith("_cas_fail")


sp.db_advance_signal_progress = fake_advance
st.db_advance_signal_progress = fake_advance


def make_user(**kw):
    d = {"lang": "ru", "progress_notify_enabled": True, "send_chart_enabled": False, "sub_plan": "pro",
         "quiet_start": -1, "quiet_end": -1}
    d.update(kw)
    return SimpleNamespace(**d)


def make_send_bot():
    sent = []

    async def send_message(uid, text, **kw):
        sent.append({"uid": uid, "text": text, **{k: (v if isinstance(v, (str, int, bool)) else str(v)) for k, v in kw.items()}})

    async def send_photo(*a, **kw):
        raise AssertionError("no photos in these vectors")

    async def edit_message_text(**kw):
        sent.append({"edit": kw["text"], "mid": kw["message_id"], "chat": kw["chat_id"]})
    return SimpleNamespace(send_message=send_message, send_photo=send_photo, edit_message_text=edit_message_text), sent


H1_START = float(df1h.index[0].timestamp())
START_I = next(i for i, b in enumerate(bars15) if b[0] >= H1_START + 60 * 3600)


def h1_upto(end_ts):
    """closed 1H bars at end_ts (open + 3600 <= end_ts), None when empty."""
    sub = df1h[df1h.index.map(lambda x: x.timestamp()) + 3600 <= end_ts]
    return sub if len(sub) else None


def find_index(pred, start=None, stop=1900):
    start = START_I if start is None else start
    for i in range(start, stop):
        if pred(i):
            return i
    raise RuntimeError("no index")


def levels_at(i, direction, k_sl=0.01, k1=0.02, k2=0.03, k3=0.045):
    c = float(df15["close"].iloc[i])
    s = 1 if direction == "LONG" else -1
    return {"direction": direction, "entry": c, "sl": c * (1 - s * k_sl), "original_sl": c * (1 - s * k_sl),
            "tp1": c * (1 + s * k1), "tp2": c * (1 + s * k2), "tp3": c * (1 + s * k3)}


def replay_from(i, tr, nbars):
    L = st.levels_from_trade(tr)
    created = bars15[i][0]
    sub = bars15[i + 1:i + 1 + nbars]
    return st.replay(L, sub, "", 0.0, created, 900)


# scenario A: TP1 then TP2 within 40 bars (LONG)
iA = find_index(lambda i: replay_from(i, levels_at(i, "LONG"), 40).stage_check if False else replay_from(i, levels_at(i, "LONG"), 40)[2][:2] == ["TP1", "TP2"] and "BE" not in replay_from(i, levels_at(i, "LONG"), 40)[2])
# scenario B: SHORT SL
iB = find_index(lambda i: replay_from(i, levels_at(i, "SHORT"), 20)[2] == ["SL"])
# scenario C: BE after TP1 (LONG)
iC = find_index(lambda i: replay_from(i, levels_at(i, "LONG", 0.01, 0.015, 0.05, 0.08), 60)[2] == ["TP1", "BE"])

scen = []


def run_scenario(name, i, tr, nbars_after, stage0="", pts=0.0, user=None, now_off=0.0, frames=None,
                 trade_extra=None, src_budget=20):
    created = bars15[i][0]
    end = i + 1 + nbars_after
    frames = frames if frames is not None else {"15m": df15.iloc[max(0, i - 50):end], "1H": h1_upto(bars15[end - 1][0] + 900)}
    src = FakeSrc(frames, rest_budget=src_budget)
    trade = {"trade_id": f"tid_{name}", "user_id": 7, "symbol": "BTC-USDT-SWAP", "timeframe": "15m", "strategy": "LEVELS",
             "created_at": created, "progress_stage": stage0, "progress_ts": pts, "order_id": "", "signal_msg_id": 123,
             "signal_card_json": json.dumps({"html": "<b>BTC LONG</b>\nкарточка"}), "entry_lo": 0, "entry_hi": 0, **tr}
    if trade_extra:
        trade.update(trade_extra)
    now = bars15[end - 1][0] + 900 + 30 + now_off
    bot, sent = make_send_bot()
    st._blocked_users.clear()
    advanced.clear()
    LOG_LINES.clear()
    u = user if user is not None else make_user()
    if user == "NONE":
        u = None
    res = asyncio.run(st.process_trade(bot, trade, u, src, now=now, png_cache={}))
    scen.append({"name": name, "i": i, "trade": trade, "now": now, "frames": {k: [len(v), float(v.index[0].timestamp()), float(v.index[-1].timestamp())] for k, v in frames.items() if v is not None},
                 "user": (vars(u) if u is not None else None), "result": res,
                 "advanced": list(advanced), "sent": sent, "src_calls": src.calls, "rest_left": src.rest_left,
                 "log": list(LOG_LINES)})


trA = levels_at(iA, "LONG")
nA = int((replay_from(iA, trA, 40)[1] - bars15[iA][0]) / 900) + 2
run_scenario("A_tp1_tp2", iA, trA, nA)
run_scenario("A_silent_lag", iA, trA, nA, now_off=7 * 3600)
run_scenario("A_notify_off", iA, trA, nA, user=make_user(progress_notify_enabled=False))
run_scenario("A_user_none_edit_only", iA, trA, nA, user="NONE")
run_scenario("A_en_quiet", iA, trA, nA, user=make_user(lang="en", quiet_start=0, quiet_end=23))
run_scenario("A_blocked_user", iA, trA, nA, user=make_user(), trade_extra={"user_id": 0})
run_scenario("A_from_tp1", iA, trA, 40, stage0="TP1", pts=replay_from(iA, trA, 40)[1] if False else [b[0] for b in bars15[iA + 1:iA + 41]][0])
run_scenario("A_cas_fail", iA, trA, 40, trade_extra={"trade_id": "tid_cas_fail"})
run_scenario("A_order_id", iA, trA, 40, trade_extra={"order_id": "ox1"})
run_scenario("A_final_stage", iA, trA, 40, stage0="SL", pts=bars15[iA + 1][0])
run_scenario("A_scale_mismatch", iA, {**trA, "entry": trA["entry"] * 1000, "sl": trA["sl"] * 1000, "original_sl": trA["sl"] * 1000, "tp1": trA["tp1"] * 1000, "tp2": trA["tp2"] * 1000, "tp3": trA["tp3"] * 1000}, 40)
run_scenario("A_no_cover", iA, trA, 40, frames={"15m": df15.iloc[iA + 5:iA + 41], "1H": None})
run_scenario("A_1h_fallback", iA, trA, 40, frames={"15m": None, "1H": h1_upto(bars15[iA + 40][0] + 900)})
run_scenario("A_invalid_levels", iA, {**trA, "tp1": trA["entry"]}, 40)
run_scenario("A_nothing_yet", iA, trA, 1)
trB = levels_at(iB, "SHORT")
run_scenario("B_short_sl", iB, trB, 20)
run_scenario("B_short_sl_en", iB, trB, 20, user=make_user(lang="en"))
trC = levels_at(iC, "LONG", 0.01, 0.015, 0.05, 0.08)
run_scenario("C_be_after_tp1", iC, trC, 60)
# zone entry (SMC): ENTRY is silent
zone = {**trA, "entry_lo": trA["entry"] * 0.999, "entry_hi": trA["entry"] * 1.001}
run_scenario("D_zone_entry", iA, zone, 1, trade_extra={"strategy": "SMC"})
run_scenario("D_zone_full", iA, zone, 40, trade_extra={"strategy": "SMC"})
out["process_trade"] = scen
out["golden"] = {"symbol": "BTC-USDT-SWAP", "iA": iA, "iB": iB, "iC": iC}

# ── 6. mark_missed on golden candles ────────────────────────────────────────
# find a bar where a zone LONG below price ran away ≥ 1R without touching the zone
def missed_case(i, direction):
    c = float(df15["close"].iloc[i])
    s = 1 if direction == "LONG" else -1
    lo, hi = c * (1 - s * 0.004), c * (1 - s * 0.002)
    tr = {"direction": direction, "entry": (lo + hi) / 2, "sl": c * (1 - s * 0.012), "original_sl": c * (1 - s * 0.012),
          "tp1": c * (1 + s * 0.02), "tp2": c * (1 + s * 0.03), "tp3": c * (1 + s * 0.045),
          "entry_lo": min(lo, hi), "entry_hi": max(lo, hi)}
    return tr


def missed_r_at(i, tr, nbars):
    L = st.levels_from_trade(tr)
    sub = bars15[i + 1:i + 1 + nbars]
    highs = np.array([b[1] for b in sub]); lows = np.array([b[2] for b in sub])
    return st.missed_r(L, highs, lows, float(df15["close"].iloc[i + nbars]))


iM = find_index(lambda i: missed_r_at(i, missed_case(i, "LONG"), 12) is not None)
trM = missed_case(iM, "LONG")
missed_rows = [
    {"trade_id": "m_zone", "user_id": 7, "symbol": "BTC-USDT-SWAP", "timeframe": "15m", "strategy": "SMC", "created_at": bars15[iM][0],
     "progress_stage": "", "progress_ts": 0, "order_id": "", "signal_msg_id": 5, "signal_card_json": json.dumps({"html": "<b>SMC</b>"}), **trM},
]
missed_rows.append({**missed_rows[0], "trade_id": "m_market", "entry_lo": 0, "entry_hi": 0, "strategy": "LEVELS"})
missed_rows.append({**missed_rows[0], "trade_id": "m_young", "created_at": bars15[iM + 12][0] + 900 - 100})
missed_rows.append({**missed_rows[0], "trade_id": "m_staged", "progress_stage": "ENTRY", "progress_ts": bars15[iM + 1][0]})
missed_rows.append({**missed_rows[0], "trade_id": "m_order", "order_id": "o1"})
missed_rows.append({**missed_rows[0], "trade_id": "m_cas_fail"})
frames_m = {"15m": df15.iloc[iM - 50:iM + 13], "1H": None}
src = FakeSrc(frames_m)
bot, sent = make_send_bot()
advanced.clear()
st._blocked_users.clear()
nowM = bars15[iM + 12][0] + 900 + 30
async def _get_user():
    return make_user()
done = asyncio.run(st.mark_missed(bot, SimpleNamespace(get=lambda uid: _get_user()), missed_rows, FakeSrc(frames_m), now=nowM))
out["mark_missed"] = {"iM": iM, "rows": missed_rows, "now": nowM, "frame": [iM - 50, iM + 13], "done": sorted(done),
                      "advanced": list(advanced), "sent": sent, "r": missed_r_at(iM, trM, 12)}

# ── 7. expire_stale with fakes ──────────────────────────────────────────────
exp_rows = [
    {"trade_id": "e1", "user_id": 7, "symbol": "BTC-USDT-SWAP", "direction": "LONG", "entry": 100.0, "sl": 95.0, "original_sl": 95.0,
     "tp1": 110.0, "tp2": 120.0, "tp3": 130.0, "progress_stage": "", "progress_ts": 0, "signal_msg_id": 9, "user_id": 7,
     "signal_card_json": json.dumps({"html": "<b>e1</b>"}), "timeframe": "1h", "strategy": "LEVELS", "created_at": 1.0},
]
exp_rows.append({**exp_rows[0], "trade_id": "e2_tp1", "progress_stage": "TP1", "progress_ts": 5.0})
exp_rows.append({**exp_rows[0], "trade_id": "e3_noprice", "symbol": "NOPRICE-USDT-SWAP"})
exp_rows.append({**exp_rows[0], "trade_id": "e4_cas_fail"})
exp_rows.append({**exp_rows[0], "trade_id": "e5_short", "direction": "SHORT", "sl": 105.0, "original_sl": 105.0, "tp1": 90.0, "tp2": 80.0, "tp3": 70.0})
exp_rows.append({**exp_rows[0], "trade_id": "e6_norisk", "sl": 100.0, "original_sl": 0})
prices = {"BTC-USDT-SWAP": 97.25}


class PriceSrc(FakeSrc):
    async def last_price(self, symbol):
        return prices.get(symbol)


async def fake_cands(now, max_age_s, grace_s=86400.0, limit=500):
    return exp_rows

marked = []


async def fake_mark(trade_id, expected, rr, pts):
    marked.append([trade_id, expected, rr, pts])
    return not trade_id.endswith("_cas_fail")

sp.db_get_expire_candidates = fake_cands
sp.db_mark_signal_expired = fake_mark
bot, sent = make_send_bot()
st._blocked_users.clear()
n = asyncio.run(st.expire_stale(bot, SimpleNamespace(get=lambda uid: _get_user()), PriceSrc({}), now=1_000_000.0))
out["expire_stale"] = {"rows": exp_rows, "price": prices, "now": 1_000_000.0, "count": n, "marked": list(marked), "sent": sent}

# ── 7b. send_progress → Forbidden (blocked user) ────────────────────────────
from aiogram.exceptions import TelegramForbiddenError  # noqa: E402


def make_forbidden_bot():
    sent = []

    async def send_message(uid, text, **kw):
        raise TelegramForbiddenError(method=None, message="Forbidden: bot was blocked by the user")

    async def edit_message_text(**kw):
        sent.append({"edit": kw["text"], "mid": kw["message_id"], "chat": kw["chat_id"]})
    return SimpleNamespace(send_message=send_message, edit_message_text=edit_message_text), sent


bot, sent = make_forbidden_bot()
st._blocked_users.clear()
advanced.clear()
LOG_LINES.clear()
_trF = {"trade_id": "tid_forbidden", "user_id": 7, "symbol": "BTC-USDT-SWAP", "timeframe": "15m", "strategy": "LEVELS",
        "created_at": bars15[iA][0], "progress_stage": "", "progress_ts": 0.0, "order_id": "", "signal_msg_id": 123,
        "signal_card_json": json.dumps({"html": "<b>BTC LONG</b>\nкарточка"}), "entry_lo": 0, "entry_hi": 0, **trA}
_endF = iA + 1 + nA
_nowF = bars15[_endF - 1][0] + 900 + 30
_resF = asyncio.run(st.process_trade(bot, _trF, make_user(), FakeSrc({"15m": df15.iloc[max(0, iA - 50):_endF], "1H": None}), now=_nowF, png_cache={}))
out["forbidden"] = {"trade": _trF, "now": _nowF, "frames": {"15m": [max(0, iA - 50), _endF]}, "result": _resF,
                    "blocked": sorted(st._blocked_users), "advanced": list(advanced), "sent": sent, "log": list(LOG_LINES)}

# ── 8. run_cycle end to end (fakes for DB, cache, REST, price, users) ───────
import cache as _cache_mod  # noqa: E402
import signal_freshness as _sf  # noqa: E402

END_C = iA + 18
NOW_C = bars15[END_C][0] + 30           # bar END_C is the forming one → last closed = END_C − 1
F15 = (max(0, iA - 60), END_C)          # iloc window of the cached 15m frame
cache_frames = {("BTC-USDT-SWAP", "15m"): df15.iloc[F15[0]:F15[1]],
                ("BTC-USDT-SWAP", "1H"): h1_upto(NOW_C)}
dfE1h = load_df("ETH-USDT-SWAP", "1h")
rest_frames = {("ETH-USDT-SWAP", "1H"): dfE1h[dfE1h.index.map(lambda x: x.timestamp()) + 3600 <= NOW_C].tail(300)}
rest_calls = []


async def fake_get_candles(symbol, tf):
    return cache_frames.get((symbol, tf))


class _Fetcher:
    async def get_candles(self, symbol, tf, limit=300):
        rest_calls.append([symbol, tf, limit])
        return rest_frames.get((symbol, tf))


cyc_prices = {"BTC-USDT-SWAP": float(df15["close"].iloc[END_C - 1])}


async def fake_price(symbol):
    return cyc_prices.get(symbol)

_cache_mod.get_candles = fake_get_candles
_sf.get_current_price = fake_price

USERS_C = {7: make_user(), 8: make_user(lang="en", sub_plan="free", quiet_start=0, quiet_end=23),
           9: make_user(progress_notify_enabled=False), 11: make_user(lang="en")}


async def _um_get(uid):
    return USERS_C.get(uid)

um_c = SimpleNamespace(get=_um_get)
base_card = json.dumps({"html": "<b>card</b>\nтекст"}, ensure_ascii=False)


def crow(tid, uid, i, tr, **kw):
    r = {"trade_id": tid, "user_id": uid, "symbol": "BTC-USDT-SWAP", "timeframe": "15m", "strategy": "LEVELS",
         "created_at": bars15[i][0], "progress_stage": "", "progress_ts": 0.0, "order_id": "", "signal_msg_id": 50 + uid,
         "signal_card_json": base_card, "entry_lo": 0, "entry_hi": 0, "result": "", "expire_rr": None, **tr}
    r.update(kw)
    return r


iE = int((rest_frames[("ETH-USDT-SWAP", "1H")].index[-30].timestamp()))
cE = float(rest_frames[("ETH-USDT-SWAP", "1H")]["close"].iloc[-30])
cyc_rows = [
    crow("c1_tp_ru", 7, iA, trA),
    crow("c2_tp_en_quiet", 8, iA, trA, strategy="VOLUME"),
    crow("c3_notify_off", 9, iA, trA),
    crow("c4_user_none", 10, iB, levels_at(iB, "SHORT")),
    crow("c5_missed_zone", 7, iM, trM, strategy="SMC", entry_lo=trM["entry_lo"], entry_hi=trM["entry_hi"]),
    crow("c6_zone_entry", 11, iA, {**trA, "entry_lo": trA["entry"] * 0.999, "entry_hi": trA["entry"] * 1.001}, strategy="SMC"),
    crow("c7_order", 7, iA, trA, order_id="ord1"),
    crow("c8_cas_fail", 7, iA, trA),
    crow("c9_final", 7, iA, trA, progress_stage="SL", progress_ts=bars15[iA + 1][0]),
    crow("c10_eth_rest", 11, iA, {"direction": "LONG", "entry": cE, "sl": cE * 0.99, "original_sl": cE * 0.99,
                                  "tp1": cE * 1.01, "tp2": cE * 1.02, "tp3": cE * 1.04}, symbol="ETH-USDT-SWAP", created_at=float(iE)),
    crow("c11_from_tp1", 7, iA, trA, progress_stage="TP1", progress_ts=replay_from(iA, trA, 40)[1]),
    crow("c12_nocover", 7, iA, trA, symbol="SOL-USDT-SWAP"),
]
cyc_rows.sort(key=lambda r: -float(r["created_at"]))          # ORDER BY created_at DESC
exp_c = [
    {"trade_id": "x1_exp", "user_id": 7, "symbol": "BTC-USDT-SWAP", "direction": "LONG", "entry": cyc_prices["BTC-USDT-SWAP"] * 0.99,
     "sl": cyc_prices["BTC-USDT-SWAP"] * 0.97, "original_sl": cyc_prices["BTC-USDT-SWAP"] * 0.97,
     "tp1": cyc_prices["BTC-USDT-SWAP"] * 1.02, "tp2": cyc_prices["BTC-USDT-SWAP"] * 1.04, "tp3": cyc_prices["BTC-USDT-SWAP"] * 1.06,
     "timeframe": "1h", "strategy": "LEVELS", "created_at": NOW_C - 80 * 3600, "signal_msg_id": 70, "progress_stage": "TP1",
     "progress_ts": NOW_C - 79 * 3600, "result": "", "order_id": "", "signal_card_json": base_card, "expire_rr": None},
    {"trade_id": "x2_exp_short_eth", "user_id": 8, "symbol": "ETH-USDT-SWAP", "direction": "SHORT", "entry": 3000.0, "sl": 3100.0,
     "original_sl": 3100.0, "tp1": 2800.0, "tp2": 2700.0, "tp3": 2500.0, "timeframe": "1h", "strategy": "SMC",
     "created_at": NOW_C - 90 * 3600, "signal_msg_id": 71, "progress_stage": "", "progress_ts": 0.0, "result": "", "order_id": "",
     "signal_card_json": base_card, "expire_rr": None},
]
trk_calls = []


async def fake_trackable(since_ts, limit=3000):
    trk_calls.append([since_ts, limit])
    return [dict(r) for r in cyc_rows]


async def fake_cands_c(now, max_age_s, grace_s=86400.0, limit=500):
    return [dict(r) for r in exp_c]

sp.db_get_trackable_signals = fake_trackable
sp.db_get_expire_candidates = fake_cands_c
advanced.clear()
marked.clear()
LOG_LINES.clear()
st._blocked_users.clear()
bot, sent = make_send_bot()
st.SEND_DELAY_S = 0.0
n_sent = asyncio.run(st.run_cycle(bot, um_c, _Fetcher(), now=NOW_C))
out["run_cycle"] = {
    "now": NOW_C, "rows": cyc_rows, "expire_rows": exp_c, "prices": cyc_prices,
    "cache": {f"{k[0]}|{k[1]}": [float(v.index[0].timestamp()), float(v.index[-1].timestamp())] for k, v in cache_frames.items() if v is not None},
    "rest": {f"{k[0]}|{k[1]}": [float(v.index[0].timestamp()), float(v.index[-1].timestamp())] for k, v in rest_frames.items()},
    "users": {str(k): vars(v) for k, v in USERS_C.items()},
    "sent_count": n_sent, "advanced": list(advanced), "marked": list(marked), "sent": sent,
    "rest_calls": rest_calls, "trackable_calls": trk_calls, "log": list(LOG_LINES),
}

json.dump(out, open(OUT, "w"), ensure_ascii=False, indent=0, default=float)
print("written", OUT, {k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in out.items()})
