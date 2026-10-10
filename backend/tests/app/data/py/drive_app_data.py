"""drive_app_data.py — the bot's own Mini App data handlers (miniapp_api.py h_dashboard, h_signals,
h_signal_chart, h_signal_result, h_stats, h_analyze, h_share, h_feedback) driven in-process over HTTP
(aiohttp TestServer, RAW request targets written to the socket) against a seeded temp DB, for
backend/tests/app/data/appDataReplay.test.js (fixture tests/app/data/fixtures/app_data_replay.json.gz).

Seed: 17 users (pro / free / trial / '' / expired pro / admin 123), 300+ trades over LEVELS / SMC /
VOLUME (+ lowercase, NULL and legacy strategies), every outcome class (exchange trades, ghost SKIP,
ORPHAN, manual results, tracker stages, EXPIRED with expire_rr, MISSED) and ages from minutes to
100 days, prices taken from the golden candles (backend/tests/golden/candles), trade_events, kv quotas
(incl. hostile counter values). Market data: the WS candle cache seeded per (symbol, tf), a fake
scanner.fetcher (REST candles, 24 h tickers, modes ok / none / raise), scanner.get_trend() texts,
trend_monitor state.

Auth: miniapp_api._tg_user is monkeypatched to read the test header X-Test-Uid (the initData check
is bypassed); everything after auth runs unchanged. time.time is pinned per step.

For the chart / analyze routes the real chart_renderer runs (its None ↔ the site's no_data) and the
site's expected payload is computed from the renderer's own inputs with the renderer's own helpers
(mirror_chart below = render_signal_chart lines 828–915 without the drawing). For share the stats the
card is drawn from are captured from share_card.render_share_png.

[STATS-HONEST 2026-10] (bot 7e20066 + 51e8256): user 117 holds the bot test's grid (stop 0.6 % → costs
0.25R / 0.20R; open TP1 with the stop at BE, ghost SKIP at TP2, exchange TP1 / BE, manual result, manual
«Пропустил» over stages SL / '' / TP1 / MISSED, an unknown stop); the last steps read its dashboard /
signals (open vs closed by `final`, r_now from sl0, limit / cost_pct keys) / stats / share under the
default costs and under SIGNAL_STATS_COST_PCT / SIGNAL_STATS_EXCHANGE_COST_PCT values (step set `env`),
and one dashboard whose signal_stats raises (step set `stats_raise` → the fallback stats + warning).

  cd /home/user/MAIN_BOT/CHM_BREAKER_V4
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> -I -B <site>/backend/tests/app/data/py/drive_app_data.py [OUT]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
(CHM_BOT_DIR=<another bot tree> runs it against that tree instead, e.g. an export of a bot commit.)
"""
from __future__ import annotations

import asyncio
import gzip
import json
import logging
import math
import os
import random
import sqlite3
import sys
import tempfile
import time as _time

BOT = os.environ.get("CHM_BOT_DIR") or "/home/user/MAIN_BOT/CHM_BREAKER_V4"
HERE = os.path.dirname(os.path.abspath(__file__))
SITE_BACKEND = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
GOLDEN = os.path.join(SITE_BACKEND, "tests", "golden", "candles")
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "..", "fixtures", "app_data_replay.json.gz")
TMP = tempfile.mkdtemp(prefix="m10b_app_data_")
DBP = os.path.join(TMP, "bot.db")
os.environ["DB_PATH"] = DBP
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
sys.dont_write_bytecode = True
os.chdir(BOT)
sys.path.insert(0, BOT)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

NOW = 1767225600.0 + 4 * 3600 + 0.5     # 2026-01-01 04:00:00.5 UTC
CLOCK = [NOW]
_time.time = lambda: CLOCK[0]

import database  # noqa: E402
import cache  # noqa: E402
import chart_renderer as cr  # noqa: E402
import miniapp_api as api  # noqa: E402
import share_card  # noqa: E402
import trend_monitor as tm  # noqa: E402
from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestServer  # noqa: E402
from user_manager import UserManager  # noqa: E402

rng = random.Random(1010)
TF_MS = {"15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
_gold: dict = {}


def golden_bars(name):
    if name not in _gold:
        with open(os.path.join(GOLDEN, f"{name}.json")) as fh:
            _gold[name] = json.load(fh)["bars"]
    return _gold[name]


def frame_bars(spec):
    """The site / bot frame of a seed spec: golden bars, cut at close cut_ms, tail n, prices × scale."""
    gtf = spec["golden"].rsplit("_", 1)[1]
    bars = golden_bars(spec["golden"])
    if spec.get("cut_ms") is not None:
        bars = [b for b in bars if b[0] + TF_MS[gtf] <= spec["cut_ms"]]
    n = spec.get("n")
    if n is not None:
        bars = bars[-n:] if n > 0 else []
    k = float(spec.get("scale", 1.0))
    if k != 1.0:
        bars = [[b[0], b[1] * k, b[2] * k, b[3] * k, b[4] * k, b[5]] for b in bars]
    return bars


def to_df(bars):
    if not bars:
        return None
    arr = np.array(bars, dtype=float)
    idx = pd.to_datetime(arr[:, 0].astype("int64"), unit="ms")
    df = pd.DataFrame({"open": arr[:, 1], "high": arr[:, 2], "low": arr[:, 3], "close": arr[:, 4],
                       "volume": arr[:, 5]}, index=idx)
    df.index.name = "open_time"
    return df


def close_at(sym, ts):
    bars = golden_bars(f"{sym}_1h")
    ms = ts * 1000
    best = bars[0]
    for b in bars:
        if b[0] <= ms:
            best = b
        else:
            break
    return best[4]


# ── seed ────────────────────────────────────────────────────────────────────
GSYMS = sorted({f.rsplit("_", 1)[0] for f in os.listdir(GOLDEN) if f.endswith(".json") and "_" in f})
USERS = [  # uid, sub_plan, sub_status, sub_expires (rel. to NOW), lang, admin
    (101, "pro", "active", 30 * 86400, "ru", 0), (102, "pro", "active", 10 * 86400, "ru", 0),
    (103, "free", "active", 0, "ru", 0), (104, "free", "expired", 0, "ru", 0),
    (105, "pro", "active", 5 * 86400, "en", 0), (106, "free", "active", 0, "en", 0),
    (107, "pro", "active", -3 * 86400, "ru", 0), (108, "free", "active", 0, "ru", 0),
    (109, "pro", "active", 60 * 86400, "ru", 0), (110, "free", "active", 0, "ru", 0),
    (111, "trial", "trial", 2 * 86400, "ru", 0), (112, "", "expired", 0, "ru", 0),
    (113, "pro", "active", 20 * 86400, "en", 0), (114, "free", "active", 0, "ru", 0),
    (115, "free", "active", 0, "ru", 0), (116, "free", "active", 0, "ru", 0),
    (123, "free", "active", 0, "ru", 1), (117, "pro", "active", 30 * 86400, "ru", 0),
]
COUNTS = {101: 70, 102: 40, 103: 18, 104: 14, 105: 22, 106: 12, 107: 16, 108: 10, 109: 25, 110: 12,
          111: 10, 112: 9, 113: 20, 114: 11, 115: 8, 116: 0, 123: 15, 117: 0}
STRATS = ["LEVELS", "SMC", "VOLUME", "LEVELS", "SMC", "VOLUME", "levels", "Smc", None, "GERCHIK", ""]
TFS = ["1h", "1h", "4h", "15m", "1H", "4H", "30m", "1d", None, ""]
CTX = ["", "aligned", "with", "counter", "strong_counter", None, ""]
trades: list = []


def created_choice():
    return rng.choice([
        NOW - rng.uniform(60, 3600), NOW - rng.uniform(3600, 86400), NOW - rng.uniform(86400, 3 * 86400),
        NOW - rng.uniform(3 * 86400, 7 * 86400), NOW - rng.uniform(7 * 86400, 16 * 86400),
        NOW - rng.uniform(16 * 86400, 40 * 86400), NOW - rng.uniform(40 * 86400, 100 * 86400),
        NOW - 72 * 3600 - rng.uniform(0, 600), float(int(NOW - rng.uniform(0, 14 * 86400)) // 3600 * 3600),
    ])


def make_levels(sym, direction, created):
    if sym in GSYMS:
        entry = close_at(sym, created)
        if rng.random() < 0.06:
            entry *= 10.0                          # pmult mismatch → the renderer refuses
    else:
        entry = rng.choice([1.2345, 0.00012, 250.5])
    s = 1 if direction == "LONG" else -1
    risk = entry * rng.choice([0.004, 0.008, 0.012, 0.02])
    lv = {"entry": entry, "sl": entry - s * risk, "tp1": entry + s * risk * rng.choice([1.0, 1.5, 2.0]),
          "tp2": entry + s * risk * rng.choice([2.5, 3.0]), "tp3": entry + s * risk * rng.choice([4.0, 4.5]),
          "tp1_rr": rng.choice([1.5, 2.0, 0.8]), "tp2_rr": rng.choice([3.0, 2.5]), "tp3_rr": rng.choice([4.5, 4.0])}
    v = rng.random()
    if v < 0.55:
        lv["original_sl"] = lv["sl"]
    elif v < 0.7:
        lv["original_sl"] = lv["sl"]
        lv["sl"] = entry                           # stop moved to break-even
    elif v < 0.78:
        lv["original_sl"] = 0.0
    if rng.random() < 0.05:
        lv["tp3"] = 0.0
    return lv


def outcome(r):
    k = rng.random()
    if k < 0.14:
        r["order_id"] = rng.choice([f"ox{rng.randint(1, 10**6)}", " ox9 "])
        r["result"] = rng.choice(["", "", "TP1", "TP2", "SL", "BE", "MANUAL", "TRAIL", "SKIP"])
        r["result_rr"] = rng.choice([0.125, 2.675, -1.0, 0.0, 1.005, round(rng.uniform(-1, 4), 3)])
        r["signal_msg_id"] = rng.choice([0, 0, 13])
        if r["result"] not in ("", "SKIP") and rng.random() < 0.5:
            r["closed_pnl_usd"] = round(rng.uniform(-40, 80), 2)
    elif k < 0.22:
        r["result"] = "SKIP"
        r["skip_reason"] = rng.choice(["ghost", "not_delivered", ""])
        r["signal_msg_id"] = rng.choice([0, 0, 22])
        r["order_id"] = rng.choice(["", "", "  "])
        r["tp_placed"] = rng.choice([0, 0, 1])
    elif k < 0.25:
        r["result"] = "ORPHAN"
    elif k < 0.32:
        r["signal_msg_id"] = 31
        r["result"] = rng.choice(["TP1", "TP2", "TP3", "SL", "BE", "SKIP", "MANUAL"])
        r["result_rr"] = {"TP1": 2.0, "TP2": 3.0, "TP3": 4.5, "SL": -1.0, "BE": 0.0, "SKIP": 0.0,
                          "MANUAL": rng.choice([0.6, -0.4, 0.0])}[r["result"]]
        if r["result"] == "SKIP":
            r["skip_reason"] = "manual"
    else:
        r["signal_msg_id"] = rng.randint(1, 999)
        r["progress_stage"] = rng.choice(["", "", "", "ENTRY", "TP1", "TP1", "TP2", "TP3", "SL", "BE", "EXPIRED",
                                          "MISSED", "tp2"])
        if r["progress_stage"] == "EXPIRED":
            r["expire_rr"] = rng.choice([None, 0.125, -0.375, round(rng.uniform(-1, 2.5), 2)])


seq = 0
for uid, *_ in USERS:
    for _ in range(COUNTS[uid]):
        seq += 1
        sym = rng.choice(GSYMS[:14] + ["NOCANDLE-USDT-SWAP", "BTC-USDT", "ETH"]) if rng.random() < 0.25 else rng.choice(GSYMS)
        gsym = sym if sym in GSYMS else None
        direction = rng.choice(["LONG", "SHORT", "LONG", "SHORT", "long"])
        created = created_choice()
        r = {"trade_id": f"t{seq:04d}", "user_id": uid, "symbol": sym, "direction": direction,
             **make_levels(gsym or sym, direction.upper(), created), "created_at": created,
             "strategy": rng.choice(STRATS), "timeframe": rng.choice(TFS),
             "quality": rng.choice([0, 1, 3, 5, 7, 10, None]), "trend_ctx": rng.choice(CTX),
             "mtf_aligned": rng.choice([0, 0, 1]), "is_counter_trend": rng.choice([0, 0, 1]),
             "result": "", "result_rr": 0.0, "order_id": "", "signal_msg_id": 0, "progress_stage": "",
             "skip_reason": "", "user_note": rng.choice(["", "", "нота", "<b>x</b>"])}
        outcome(r)
        trades.append(r)
# hand-made rows the result / chart cases rely on
SPECIAL = [
    {"trade_id": "fresh-1", "user_id": 101, "symbol": "BTC-USDT-SWAP", "direction": "LONG", "strategy": "LEVELS",
     "timeframe": "1h", "created_at": NOW - 5 * 3600, "signal_msg_id": 7},
    {"trade_id": "fresh-2", "user_id": 101, "symbol": "ETH-USDT-SWAP", "direction": "SHORT", "strategy": "SMC",
     "timeframe": "4h", "created_at": NOW - 9 * 3600, "signal_msg_id": 8, "original_sl": 0.0},
    {"trade_id": "fresh-3", "user_id": 101, "symbol": "SYNUP01-USDT-SWAP", "direction": "LONG", "strategy": "VOLUME",
     "timeframe": "1h", "created_at": NOW - 26 * 3600, "signal_msg_id": 9, "tp3": 0.0},
    {"trade_id": "fresh-4", "user_id": 101, "symbol": "SYNDN01-USDT-SWAP", "direction": "SHORT", "strategy": "LEVELS",
     "timeframe": "15m", "created_at": NOW - 2 * 3600, "signal_msg_id": 10},
    {"trade_id": "fresh-5", "user_id": 101, "symbol": "SYNRG01-USDT-SWAP", "direction": "LONG", "strategy": "SMC",
     "timeframe": "1H", "created_at": NOW - 40 * 3600, "signal_msg_id": 11},
    {"trade_id": "fresh-6", "user_id": 101, "symbol": "SYNLV02-USDT-SWAP", "direction": "LONG", "strategy": "LEVELS",
     "timeframe": "1h", "created_at": NOW - 3 * 3600, "signal_msg_id": 12},
    {"trade_id": "fresh-7", "user_id": 102, "symbol": "BTC-USDT-SWAP", "direction": "SHORT", "strategy": "LEVELS",
     "timeframe": "1h", "created_at": NOW - 7 * 3600, "signal_msg_id": 13},
    {"trade_id": "ghost-1", "user_id": 101, "symbol": "ETH-USDT-SWAP", "direction": "LONG", "strategy": "LEVELS",
     "timeframe": "1h", "created_at": NOW - 4 * 86400, "result": "SKIP", "skip_reason": "ghost", "tp_placed": 1},
    {"trade_id": "exch-1", "user_id": 101, "symbol": "BTC-USDT-SWAP", "direction": "LONG", "strategy": "LEVELS",
     "timeframe": "1h", "created_at": NOW - 6 * 3600, "order_id": "ord-77"},
    {"trade_id": "done-1", "user_id": 101, "symbol": "BTC-USDT-SWAP", "direction": "LONG", "strategy": "SMC",
     "timeframe": "1h", "created_at": NOW - 8 * 3600, "result": "MANUAL", "result_rr": 0.4},
    {"trade_id": "a/b", "user_id": 101, "symbol": "ETH-USDT-SWAP", "direction": "LONG", "strategy": "LEVELS",
     "timeframe": "1h", "created_at": NOW - 10 * 3600, "signal_msg_id": 14},
    {"trade_id": "a%zzb", "user_id": 101, "symbol": "BTC-USDT-SWAP", "direction": "SHORT", "strategy": "LEVELS",
     "timeframe": "1h", "created_at": NOW - 11 * 3600, "signal_msg_id": 15},
    {"trade_id": "%ff", "user_id": 101, "symbol": "BTC-USDT-SWAP", "direction": "LONG", "strategy": "LEVELS",
     "timeframe": "1h", "created_at": NOW - 12 * 3600, "signal_msg_id": 16},
    {"trade_id": "тест", "user_id": 101, "symbol": "BTC-USDT-SWAP", "direction": "LONG", "strategy": "LEVELS",
     "timeframe": "1h", "created_at": NOW - 13 * 3600, "signal_msg_id": 17},
    {"trade_id": "a b+c", "user_id": 101, "symbol": "SYNUP02-USDT-SWAP", "direction": "LONG", "strategy": "VOLUME",
     "timeframe": "4h", "created_at": NOW - 14 * 3600, "signal_msg_id": 18},
    {"trade_id": "..", "user_id": 101, "symbol": "BTC-USDT-SWAP", "direction": "LONG", "strategy": "LEVELS",
     "timeframe": "1h", "created_at": NOW - 15 * 3600, "signal_msg_id": 19},
    {"trade_id": "%", "user_id": 101, "symbol": "BTC-USDT-SWAP", "direction": "LONG", "strategy": "LEVELS",
     "timeframe": "1h", "created_at": NOW - 16 * 3600, "signal_msg_id": 20},
    {"trade_id": "skp-1", "user_id": 103, "symbol": "BTC-USDT-SWAP", "direction": "LONG", "strategy": "LEVELS",
     "timeframe": "1h", "created_at": NOW - 3600, "signal_msg_id": 21},
    {"trade_id": "old-1", "user_id": 102, "symbol": "SYNUP03-USDT-SWAP", "direction": "LONG", "strategy": "LEVELS",
     "timeframe": "1h", "created_at": NOW - 45 * 86400, "signal_msg_id": 22, "progress_stage": "TP2"},
    {"trade_id": "zero-ts", "user_id": 102, "symbol": "SYNUP04-USDT-SWAP", "direction": "SHORT", "strategy": "LEVELS",
     "timeframe": "1h", "created_at": 0.0, "signal_msg_id": 23, "progress_stage": "SL"},
]
for sp in SPECIAL:
    sym = sp["symbol"] if sp["symbol"] in GSYMS else "BTC-USDT-SWAP"
    lv = make_levels(sym, sp["direction"], sp["created_at"] or NOW - 86400)
    lv["entry"] = close_at(sym, sp["created_at"] or NOW - 86400)
    s = 1 if sp["direction"] == "LONG" else -1
    risk = lv["entry"] * 0.01
    lv.update({"sl": lv["entry"] - s * risk, "original_sl": lv["entry"] - s * risk, "tp1": lv["entry"] + s * risk * 1.5,
               "tp2": lv["entry"] + s * risk * 3.0, "tp3": lv["entry"] + s * risk * 4.5})
    r = {"result": "", "result_rr": 0.0, "order_id": "", "signal_msg_id": 0, "progress_stage": "", "skip_reason": "",
         "user_note": "", "quality": 5, "trend_ctx": "", "mtf_aligned": 0, "is_counter_trend": 0, **lv}
    r.update(sp)
    trades.append(r)
TRADE_COLS = sorted({k for r in trades for k in r})

EVENTS = []
for r in rng.sample(trades, 30):
    EVENTS.append({"trade_id": r["trade_id"], "ts": r["created_at"] + 5, "event_type": "signal_generated",
                   "payload_json": json.dumps({"symbol": r["symbol"], "strategy": r["strategy"]})})

# [STATS-HONEST 2026-10] user 117: the bot test's grid (tests/test_signal_stats_honest_2026_10.py, stop 0.6 % of
# the entry, TP 1.0 / 2.9 / 3.9R) on cached golden symbols, no rng (appended after the event sample)
LIVE_SYMS = [x for i, x in enumerate(GSYMS) if i % 3 != 2][:4]


def honest_row(tid, sym, created, direction="LONG", scale=1.0, **kw):
    e = close_at(sym, created) * scale         # scale ≠ 1 → the cached last close is off the entry (r_now ≠ 0)
    k = 1 if direction == "LONG" else -1
    r = {"trade_id": tid, "user_id": 117, "symbol": sym, "direction": direction, "entry": e,
         "sl": e * (1 - k * 0.006), "original_sl": e * (1 - k * 0.006), "tp1": e * (1 + k * 0.006),
         "tp2": e * (1 + k * 0.0174), "tp3": e * (1 + k * 0.0234), "tp1_rr": 1.0, "tp2_rr": 2.9, "tp3_rr": 3.9,
         "created_at": created, "strategy": "VOLUME", "timeframe": "15m", "quality": 4, "trend_ctx": "",
         "mtf_aligned": 0, "is_counter_trend": 0, "result": "", "result_rr": None, "order_id": "", "signal_msg_id": 7,
         "progress_stage": "", "skip_reason": "", "user_note": ""}
    r.update(kw)
    return r


S0, S1, S2, S3 = LIVE_SYMS
HONEST = [
    honest_row("h-tp1-open", S0, NOW - 5 * 3600, scale=0.997, progress_stage="TP1"),
    honest_row("h-tp2-skip", S1, NOW - 4 * 3600, scale=0.99, progress_stage="TP2", result="SKIP"),
    honest_row("h-tp3", S2, NOW - 3 * 3600, progress_stage="TP3"),
    honest_row("h-sl", S3, NOW - 2 * 3600, progress_stage="SL"),
    honest_row("h-be", S0, NOW - 3500, progress_stage="BE"),
    honest_row("h-exp", S1, NOW - 3 * 86400, progress_stage="EXPIRED", expire_rr=0.4),
    honest_row("h-missed", S2, NOW - 2 * 86400, progress_stage="MISSED"),
    honest_row("h-ex-tp1", S3, NOW - 6 * 3600, progress_stage="TP1", order_id="o-h1", result="TP1", result_rr=0.95,
               strategy="LEVELS"),
    honest_row("h-ex-be", S0, NOW - 7 * 3600, order_id="o-h2", result="BE", result_rr=0.02, strategy="LEVELS"),
    honest_row("h-old-sl", S1, NOW - 10 * 86400, progress_stage="SL"),
    honest_row("h-manual-tp2", S2, NOW - 1800, result="TP2", result_rr=2.9),
    honest_row("h-fresh", S3, NOW - 600, scale=1.002),
    honest_row("h-short-tp1", S1, NOW - 4.5 * 3600, direction="SHORT", scale=1.004, progress_stage="TP1", strategy="SMC"),
    honest_row("h-ms-sl", S0, NOW - 8 * 3600, result="SKIP", skip_reason="manual", progress_stage="SL"),
    honest_row("h-ms-open", S1, NOW - 9 * 3600, result="SKIP", skip_reason="manual"),
    honest_row("h-ms-tp1", S2, NOW - 10 * 3600, result="SKIP", skip_reason="manual", progress_stage="TP1"),
    honest_row("h-ms-missed", S3, NOW - 11 * 3600, result="SKIP", skip_reason="manual", progress_stage="MISSED"),
    honest_row("h-nostop", S0, NOW - 12 * 3600, progress_stage="SL", sl=0.0, original_sl=0.0),
]
HONEST[0]["sl"] = HONEST[0]["entry"]             # the stop moved to break-even (original_sl keeps the scale)
HONEST[12]["sl"] = HONEST[12]["entry"]
trades.extend(HONEST)
TRADE_COLS = sorted({k for r in trades for k in r})
DAY = int(NOW) // 86400
KV = {
    f"analyze_count_103_{DAY}": "0",           # free, used none (int("0") = 0)
    f"analyze_count_104_{DAY}": "1",           # free, quota used up
    f"analyze_count_106_{DAY}": " 1 ",         # int(" 1 ") = 1 → used up
    f"analyze_count_108_{DAY}": "abc",         # int("abc") → ValueError → HTTP 500
    f"analyze_count_110_{DAY - 1}": "1",       # yesterday's counter: today is free
    f"miniapp_feedback_104_{DAY}": "5",        # 6th today → rate_limited
    f"miniapp_feedback_106_{DAY}": "99999999999999999999",   # CAST overflow → '9.22…e+18' → int() fails → 1
    f"miniapp_feedback_108_{DAY}": "4",
}

# market data
CACHE_SEED = []
for i, sym in enumerate(GSYMS):
    if i % 3 == 2:
        continue                                  # every third symbol: nothing cached
    for tf, gtf, n in (("15m", "15m", 300), ("1H", "1h", 300), ("4H", "4h", 300)):
        if tf == "4H" and i % 2:
            continue
        CACHE_SEED.append({"symbol": sym, "tf": tf, "golden": f"{sym}_{gtf}", "n": n})
CACHE_SEED.append({"symbol": "SYNUP02-USDT-SWAP", "tf": "4H", "golden": "SYNUP02-USDT-SWAP_4h", "n": 40})   # < 60 → REST
CACHE_SEED.append({"symbol": "SYNVL01-USDT-SWAP", "tf": "1H", "golden": "SYNVL01-USDT-SWAP_1h", "n": 300, "scale": 0.1})
REST_SEED = {s: {"mode": "ok"} for s in GSYMS}
REST_SEED["SYNVL02-USDT-SWAP"] = {"mode": "short", "n": 20}      # < 30 bars → no_data
REST_SEED["SYNVL03-USDT-SWAP"] = {"mode": "none"}
REST_SEED["SYNVL04-USDT-SWAP"] = {"mode": "raise"}
for base, cut in (("SYNDN02", 1767182400000), ("SYNRG01", 1766710800000), ("SYNLV04", 1766703600000),
                  ("SYNUP01", 1766631600000), ("SYNLV03", 1766840400000)):
    REST_SEED[f"{base}-USDT-SWAP"] = {"mode": "ok", "cut_ms": cut}
REST_SEED["BTC-USDT-SWAP"] = {"mode": "ok", "cut_ms": 1766743200000}
TICKERS = {
    "BTC-USDT-SWAP": {"mode": "ok", "last": 73458.52026, "change_pct": 1.23456, "drift": 0.25},
    "ETH-USDT-SWAP": {"mode": "ok", "last": 5245.660744, "change_pct": -0.004999, "drift": -0.01},
    "SYNDN02-USDT-SWAP": {"mode": "ok", "last": 12.5, "change_pct": 2.675, "drift": 0},
    "SYNRG01-USDT-SWAP": {"mode": "none"},
    "SYNLV04-USDT-SWAP": {"mode": "ok", "last": "0.5", "change_pct": "3.3", "drift": 0},
    "TIMEOUT-USDT-SWAP": {"mode": "raise"},
}
TREND_RAW = {"BTC": {"trend_text": "H1: 🟢 | H4: 🔴 | D1: ⚪ | W1: ❓"},
             "ETH": {"trend_text": "H1:🔴|H4:🟢| D1 : 🟢 |junk| W1"}}
TREND_STATE = {"15m": {"trend": "LONG", "since": NOW - 3600, "price": 73458.52},
               "1H": {"trend": "SHORT", "since": NOW - 7200.5, "price": 73400.0},
               "1D": {"trend": "RANGE", "since": NOW - 86400 * 3, "price": 72000.0}}
TREND_STRENGTH = {"15m": 86.6, "1H": 12.0}
STATE = {"tickers": json.loads(json.dumps(TICKERS)), "rest": json.loads(json.dumps(REST_SEED)), "trend_raw": TREND_RAW}


def bars_for(sym, tf, limit):
    spec = STATE["rest"].get(sym)
    if not spec:
        return None
    if spec["mode"] == "none":
        return None
    if spec["mode"] == "raise":
        raise RuntimeError("REST boom")
    gtf = {"1h": "1h", "4h": "4h", "15m": "15m", "1d": "1d"}.get(str(tf).lower())
    if not gtf:
        return None
    n = spec.get("n", limit) if spec["mode"] == "short" else limit
    return frame_bars({"golden": f"{sym}_{gtf}", "cut_ms": spec.get("cut_ms"), "n": min(n, limit)})


class FakeFetcher:
    async def get_candles(self, symbol, tf, limit=300):
        return to_df(bars_for(symbol, tf, limit))

    async def get_24h_change(self, symbol):
        t = STATE["tickers"].get(symbol)
        if not t:
            return None
        if t["mode"] == "none":
            return None
        if t["mode"] == "raise":
            raise asyncio.TimeoutError()
        last = t["last"]
        if isinstance(last, (int, float)) and t.get("drift"):
            last = last + t["drift"] * (CLOCK[0] - NOW)
        return {"last": last, "change_pct": t["change_pct"]}


class FakeScanner:
    fetcher = FakeFetcher()

    def get_trend(self):
        return STATE["trend_raw"]


# ── captures ────────────────────────────────────────────────────────────────
RENDERS: list = []
SHARES: list = []
_orig_render = cr.render_signal_chart


def mirror_chart(df, *, symbol, direction, entry, sl, tp1=0.0, tp2=0.0, tp3=0.0, strategy="LEVELS", quality="",
                 score=0.0, pivot_levels=None, hvn_levels=None, lvn_levels=None, extra_signal_data=None, tier="pro",
                 user_label="", lang="ru", timeframe="", event="", hit_levels=None, be_price=None, entry_time=None):
    """render_signal_chart lines 828–915 without the drawing → the site's chart payload."""
    if df is None or len(df) < 10:
        return None
    feats = cr._features_for_tier(tier)
    direction = (direction or "LONG").upper()
    strategy = (strategy or "").upper()
    progress = bool(event or hit_levels or (be_price and be_price > 0))
    entry, sl = float(entry or 0), float(sl or 0)
    tp1, tp2, tp3 = float(tp1 or 0), float(tp2 or 0), float(tp3 or 0)
    full = df
    for col in ("open", "high", "low", "close"):
        if col not in full.columns:
            return None
    times_full = cr._extract_times(full)
    n_bars = feats["bars"]
    entry_pos_full = None
    if progress and entry_time is not None and times_full is not None:
        et = pd.Timestamp(entry_time)
        pos = int(times_full.searchsorted(et, side="right")) - 1
        entry_pos_full = max(0, min(pos, len(full) - 1))
        n_bars = min(200, max(n_bars, len(full) - entry_pos_full + 15))
    start = max(0, len(full) - n_bars)
    win = full.iloc[start:].reset_index(drop=True)
    win = win.apply(pd.to_numeric, errors="coerce").ffill().bfill()
    times = times_full[start:] if times_full is not None else None
    n = len(win)
    last_close = float(win["close"].iloc[-1])
    if last_close > 0 and entry > 0:
        if max(entry, last_close) / min(entry, last_close) > 5.0:
            return None
    if entry <= 0:
        entry = last_close
    tf = cr._tf_label(cr._bar_seconds(times)) or (timeframe or "")
    emas = []
    if feats["ema"]:
        periods = (extra_signal_data or {}).get("ema_periods")
        if not periods:
            periods = (("S10", "S20", "S50", "E200") if strategy == "VOLUME" else (20, 50, 200))
        close_full = pd.to_numeric(full["close"], errors="coerce")
        for label, ser in cr._calc_emas(close_full, periods):
            kind, p = label.split(" ")
            vals = ser.to_numpy(dtype=float)[start:]
            emas.append({"name": p, "label": label, "kind": kind, "period": int(p),
                         "values": [None if v != v else float(v) for v in vals]})
    tps = [("TP1", tp1), ("TP2", tp2), ("TP3", tp3)]
    is_long = direction != "SHORT"
    hits_u = {h.upper() for h in (hit_levels or [])}
    if progress:
        if entry_pos_full is not None:
            entry_idx = max(0, entry_pos_full - start)
        else:
            hp = [(p, is_long) for nm, p in tps if p > 0 and nm in hits_u]
            if sl > 0 and "SL" in hits_u:
                hp.append((sl, not is_long))
            entry_idx = cr._guess_entry_idx(win, entry, hp)
    else:
        entry_idx = n - 1
    t_ms = (full.index.asi8[start:] // 1_000_000).tolist()
    candles = [[int(t_ms[i])] + [float(win[c].iloc[i]) for c in ("open", "high", "low", "close", "volume")] for i in range(n)]
    return {
        "timeframe": tf,
        "meta": {"symbol": cr._norm_symbol(symbol), "strategy": strategy, "direction": direction,
                 "quality": str(quality or ""), "score": float(score or 0)},
        "candles": candles,
        "overlays": {"entry": entry, "sl": sl, "tps": [tp1, tp2, tp3],
                     "be": float(be_price) if be_price is not None and be_price > 0 else None,
                     "ob": [], "fvg": [], "pivots": [], "hvn": [], "lvn": [], "emas": emas},
        "event": str(event or ""), "hit_levels": [str(h) for h in (hit_levels or [])],
        "entry_index": int(entry_idx), "last_close": last_close,
    }


def render_spy(df, **kw):
    png = _orig_render(df, **kw)
    mirror = mirror_chart(df, **kw)
    RENDERS.append({"kw": {k: (v.timestamp() if isinstance(v, pd.Timestamp) else v) for k, v in kw.items()},
                    "png": bool(png), "mirror": mirror, "rows": 0 if df is None else len(df)})
    return png


cr.render_signal_chart = render_spy
_orig_share = share_card.render_share_png


def share_spy(stats, username="", days=30, lang="ru", now=None):
    SHARES.append({"stats": json.loads(json.dumps(stats)), "days": days, "lang": lang})
    return _orig_share(stats, username, days, lang, now)


share_card.render_share_png = share_spy


class LogCap(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines = []

    def emit(self, record):
        if record.levelno >= logging.INFO:
            self.lines.append(f"{record.levelname} {record.getMessage()}")


LOGS = LogCap()
for name in ("CHM.MiniApp",):
    lg = logging.getLogger(name)
    lg.addHandler(LOGS)
    lg.setLevel(logging.DEBUG)
logging.getLogger().setLevel(logging.WARNING)


def _tg_user(request):
    v = request.headers.get("X-Test-Uid", "")
    return {"id": int(v), "username": f"user{v}", "first_name": "T", "language_code": "ru"} if v else None


api._tg_user = _tg_user
_orig_signal_stats = api._signal_stats


async def _signal_stats_spy(user_id, days=30):
    """[STATS-HONEST] step set `stats_raise`: h_dashboard's signal_stats read fails → the fallback stats."""
    if STATE.get("stats_raise"):
        raise RuntimeError("stats boom")
    return await _orig_signal_stats(user_id, days)


api._signal_stats = _signal_stats_spy


# ── raw HTTP ────────────────────────────────────────────────────────────────
async def raw_request(port, method, target, uid, body, ctype):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    data = body.encode("utf-8") if isinstance(body, str) else (body or b"")
    head = [f"{method} {target} HTTP/1.1", "Host: 127.0.0.1", "Connection: close"]
    if uid is not None:
        head.append(f"X-Test-Uid: {uid}")
    if ctype:
        head.append(f"Content-Type: {ctype}")
    if method in ("POST", "PUT", "DELETE") or data:
        head.append(f"Content-Length: {len(data)}")
    writer.write(("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + data)
    await writer.drain()
    raw = await reader.read()
    writer.close()
    hdr, _, rest = raw.partition(b"\r\n\r\n")
    lines = hdr.decode("latin-1").split("\r\n")
    status = int(lines[0].split(" ")[1])
    headers = {}
    for ln in lines[1:]:
        k, _, v = ln.partition(":")
        headers[k.strip().lower()] = v.strip()
    if headers.get("transfer-encoding") == "chunked":
        out = b""
        while rest:
            size, _, rest = rest.partition(b"\r\n")
            n = int(size, 16)
            if n == 0:
                break
            out += rest[:n]
            rest = rest[n + 2:]
        rest = out
    return status, headers, rest.decode("utf-8", "replace")


def trade_snapshot(con, tid):
    row = con.execute("SELECT result, result_rr, skip_reason, state, state_changed_at, user_note FROM trades WHERE trade_id=?",
                      (tid,)).fetchone()
    ev = con.execute("SELECT ts, event_type, payload_json FROM trade_events WHERE trade_id=? ORDER BY id", (tid,)).fetchall()
    return {"row": list(row) if row else None, "events": [list(e) for e in ev]}


def kv_snapshot(con, uid):
    rows = con.execute("SELECT key, value FROM kv WHERE key LIKE ? OR key LIKE ? ORDER BY key",
                       (f"analyze_count_{uid}_%", f"miniapp_feedback_{uid}_%")).fetchall()
    return {k: v for k, v in rows}


# ── steps ───────────────────────────────────────────────────────────────────
STEPS: list = []
T = [NOW]


def step(name, uid, method, path, body=None, *, ctype="application/json", dt=5.0, sets=None, trade=None):
    T[0] += dt
    STEPS.append({"name": name, "uid": uid, "method": method, "path": path, "body": body, "ctype": ctype,
                  "now": T[0], "set": sets or {}, "trade": trade})


B = "/miniapp/api"
J = json.dumps

# unauthenticated
for m, p in (("GET", "/dashboard"), ("GET", "/signals"), ("GET", "/signals/fresh-1/chart"), ("POST", "/signals/fresh-1/result"),
             ("GET", "/stats"), ("POST", "/analyze"), ("POST", "/share"), ("POST", "/feedback")):
    step(f"unauth {m} {p}", None, m, B + p, "{}" if m == "POST" else None)

# dashboard: market cache (60 s), tickers none / raise, trend texts, trend monitor state, rating cache
step("dashboard 101", 101, "GET", B + "/dashboard", sets={"trend_state": TREND_STATE, "trend_strength": TREND_STRENGTH})
step("dashboard 101 cached market", 101, "GET", B + "/dashboard", dt=20)
step("dashboard 102 cache still fresh", 102, "GET", B + "/dashboard", dt=30)
step("dashboard 103 cache expired, ETH none", 103, "GET", B + "/dashboard", dt=15,
     sets={"tickers": {"ETH-USDT-SWAP": {"mode": "none"}}})
step("dashboard 104 BTC raises, cached for 60 s", 104, "GET", B + "/dashboard", dt=70,
     sets={"tickers": {"BTC-USDT-SWAP": {"mode": "raise"}, "ETH-USDT-SWAP": {"mode": "ok", "last": 5000.0, "change_pct": 0.125, "drift": 0}}})
step("dashboard 105 both fail (empty not cached)", 105, "GET", B + "/dashboard", dt=65,
     sets={"tickers": {"BTC-USDT-SWAP": {"mode": "none"}, "ETH-USDT-SWAP": {"mode": "raise"}},
           "trend_raw": {"BTC": {"trend_text": ""}, "ETH": None}})
step("dashboard 106 recovers", 106, "GET", B + "/dashboard", dt=3,
     sets={"tickers": {"BTC-USDT-SWAP": {"mode": "ok", "last": "73000.5", "change_pct": "0.335", "drift": 0},
                       "ETH-USDT-SWAP": {"mode": "ok", "last": 0, "change_pct": None, "drift": 0}},
           "trend_raw": {"BTC": {"trend_text": "H1 🟢 | : | H4:🟢:🔴 |H1: 🔴"}, "ETH": {"trend_text": None}}})
for uid in (107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 123):
    step(f"dashboard {uid}", uid, "GET", B + "/dashboard", dt=11, sets={"trend_raw": TREND_RAW} if uid == 107 else None)
step("dashboard 101 rating cache (15 min) — after results", 101, "GET", B + "/dashboard", dt=5)

# signals: query variants
SIGQ = ["", "?status=open", "?status=closed", "?status=all&limit=5", "?limit=200", "?limit=0", "?limit=-5", "?limit=abc",
        "?limit=%201%20", "?limit=+7", "?limit=%2B7", "?limit=1_0", "?limit=1e3", "?limit=%D9%A3", "?limit=9999999999999999999999",
        "?limit=" + "9" * 5000, "?status=OPEN", "?status=open%20", "?status=open&status=closed", "?status=closed&limit=3",
        "?strategy=levels", "?strategy=Smc&status=open", "?strategy=VOLUME&status=closed&limit=4", "?strategy=junk",
        "?strategy=%C5%BFmc", "?strategy=levels&strategy=smc", "?strategy=", "?status[]=open", "?;status=open",
        "?status=%zz", "?limit=%ff", "?&&status=closed&&", "?limit", "?status=open#frag", "?limit=60", "?limit=51&status=open",
        "?STATUS=open", "?strategy=%20smc"]
for q in SIGQ:
    step(f"signals 101 {q[:40]}", 101, "GET", B + "/signals" + q, dt=2)
for uid in (102, 103, 105, 107, 109, 111, 113, 116, 123):
    step(f"signals {uid}", uid, "GET", B + "/signals", dt=3)
    step(f"signals {uid} open", uid, "GET", B + "/signals?status=open&limit=3", dt=3)

# stats: query variants
STATQ = ["", "?days=7", "?days=1", "?days=0", "?days=-3", "?days=365", "?days=366", "?days=90", "?days=abc", "?days=%2030",
         "?days=1e2", "?days=" + "1" * 4400, "?strategy=SMC", "?strategy=levels&tf=1h", "?tf=1H", "?tf=4h&days=60",
         "?tf=15m&strategy=VOLUME", "?tf=junk", "?strategy=junk&tf=", "?days=30&days=7", "?days=+14"]
for q in STATQ:
    step(f"stats 101 {q[:40]}", 101, "GET", B + "/stats" + q, dt=2)
for uid in (102, 103, 104, 105, 109, 113, 116, 123):
    step(f"stats {uid}", uid, "GET", B + "/stats?days=90", dt=3)

# chart: owner, hostile ids, statuses, cache vs REST, no_data, pmult, the 10 / 60 s bucket
CHART_IDS = ["fresh-1", "fresh-2", "fresh-3", "fresh-4", "fresh-5", "fresh-6", "old-1", "zero-ts", "ghost-1", "exch-1",
             "done-1", "fresh-7", "nope", "a%2Fb", "a%2fb", "a%zzb", "%ff", "%D1%82%D0%B5%D1%81%D1%82", "a%20b+c",
             "%2E%2E", "%25", "a%7Bb", "x" * 300]
for i, tid in enumerate(CHART_IDS):
    step(f"chart {tid[:30]}", 101, "GET", B + f"/signals/{tid}/chart", dt=7)
for r in [t for t in trades if t["user_id"] in (102, 105, 109, 113) and not t["trade_id"].startswith(("fresh", "old", "zero"))][:36]:
    step(f"chart {r['trade_id']} u{r['user_id']}", r["user_id"], "GET", B + f"/signals/{r['trade_id']}/chart", dt=7)
for k in range(12):
    step(f"chart burst {k}", 113, "GET", B + "/signals/nope/chart", dt=0.5)
step("chart 102 of 101's trade → 404", 102, "GET", B + "/signals/fresh-1/chart", dt=61)
step("chart SYNVL02 short REST", 101, "GET", B + "/signals/fresh-1/chart", dt=1,
     sets={"rest": {"BTC-USDT-SWAP": {"mode": "short", "n": 20}}})
step("chart REST raises", 101, "GET", B + "/signals/fresh-1/chart", dt=1, sets={"rest": {"BTC-USDT-SWAP": {"mode": "raise"}}})
step("chart REST none", 101, "GET", B + "/signals/fresh-1/chart", dt=1, sets={"rest": {"BTC-USDT-SWAP": {"mode": "none"}}})
step("chart REST back", 101, "GET", B + "/signals/fresh-1/chart", dt=1, sets={"rest": {"BTC-USDT-SWAP": {"mode": "ok"}}})

# routing: method / slash / case
for m, p in (("POST", "/dashboard"), ("GET", "/analyze"), ("GET", "/signals/fresh-1/result"), ("POST", "/signals/fresh-1/chart"),
             ("DELETE", "/stats"), ("GET", "/signals/fresh-1/chart/"), ("GET", "/signals//chart"), ("GET", "/Signals"),
             ("GET", "/signals/"), ("GET", "/x/../dashboard"), ("GET", "/./stats"), ("GET", "/signals/./fresh-1/chart"),
             ("GET", "/dash%62oard"), ("GET", "/signals%2Ffresh-1%2Fchart")):
    step(f"route {m} {p}", 109, m, B + p, "{}" if m in ("POST", "DELETE") else None, dt=1)

# manual result
RES = [
    ("fresh-1", J({"result": " tp1 "})), ("fresh-1", J({"result": "TP2"})), ("fresh-2", J({"result": "TP2"})),
    ("fresh-3", J({"result": "TP3", "note": "  взял руками  "})), ("fresh-4", J({"result": "ſl"})),
    ("fresh-5", J({"result": "BE"})), ("fresh-6", J({"result": "SKIP"})), ("fresh-6", J({"result": "TP1"})),
    ("ghost-1", J({"result": "TP1"})), ("exch-1", J({"result": "SL"})), ("done-1", J({"result": "SL"})),
    ("done-1", J({"note": "ок"})), ("fresh-7", J({"result": "TP1"})), ("nope", J({"result": "TP1"})),
    ("fresh-1", J({})), ("fresh-1", "not json"), ("fresh-1", J({"result": "tp4"})), ("fresh-1", J({"result": 1})),
    ("fresh-1", J({"result": True})), ("fresh-1", J({"result": []})), ("fresh-1", J({"result": [], "note": "x"})),
    ("fresh-1", J({"note": None})), ("fresh-1", J({"note": 5})), ("fresh-1", J({"note": "я" * 500})),
    ("fresh-1", J({"note": "я" * 501})), ("fresh-1", J({"note": "😀" * 500})), ("fresh-1", J({"note": "😀" * 501})),
    ("fresh-1", J({"note": ""})), ("fresh-1", J({"note": "  trimmed  "})), ("a%2Fb", J({"note": "slash id"})),
    ("%ff", J({"result": "SL"})), ("a%zzb", J({"result": "BE"})), ("%D1%82%D0%B5%D1%81%D1%82", J({"result": "TP2"})),
    ("a%20b+c", J({"result": "TP1"})), ("%25", J({"result": "SKIP"})), ("skp-1", J({"result": "SKIP", "note": 7})),
    ("skp-1", J({"result": "TP3"})), ("old-1", '{"result": "TP2", "note": NaN}'), ("zero-ts", '{"result": "SL", "result": "BE"}'),
]
for tid, body in RES:
    owner = 103 if tid.startswith("skp") else 102 if tid in ("fresh-7", "old-1", "zero-ts") else 101
    step(f"result {tid[:20]} {body[:40]}", owner, "POST", B + f"/signals/{tid}/result", body, dt=3,
         trade=__import__("urllib.parse").parse.unquote(tid) if "%" in tid and tid not in ("a%zzb", "%ff") else tid)
step("result other user's trade", 102, "POST", B + "/signals/fresh-2/result", J({"result": "SL"}), dt=3, trade="fresh-2")
step("signals 101 after results", 101, "GET", B + "/signals?limit=200", dt=2)
step("stats 101 after results", 101, "GET", B + "/stats", dt=2)

# analyze
AN = [
    (101, J({"symbol": "syndn02", "strategy": "auto"})), (101, J({"symbol": "BTC/USDT", "strategy": "SMC"})),
    (101, J({"symbol": "SYNRG01USDT", "strategy": "levels"})), (101, J({"symbol": "synlv04", "strategy": "VOLUME"})),
    (101, J({"symbol": "SYNUP01", "strategy": "junk"})), (101, J({"symbol": "SYNLV03"})),
    (101, J({"symbol": "NOPE1", "strategy": "AUTO"})), (101, J({"symbol": "TIMEOUT"})),
    (105, J({"symbol": "SYNDN02"})), (105, J({"symbol": "SYNDN02"})),
    (103, J({"symbol": "eth"})), (103, J({"symbol": "eth"})), (104, J({"symbol": "BTC"})), (106, J({"symbol": "BTC"})),
    (108, J({"symbol": "BTC"})), (110, J({"symbol": "SYNVL03"})), (123, J({"symbol": "SYNVL04"})), (123, J({"symbol": "SYNVL01"})),
    (109, J({"symbol": ""})), (109, J({"symbol": "X"})), (109, J({"symbol": "a<b"})), (109, J({"symbol": 123})),
    (109, J({"symbol": 10.0})), (109, '{"symbol": 1e14}'), (109, J({"symbol": ["BTC"]})), (109, J({"symbol": "ABCDEFGHIJKLMNOP"})),
    (109, J({})), (109, "garbage"), (109, J({"symbol": "  btc "})), (109, J({"symbol": "1000PEPE", "strategy": 5})),
]
for uid, body in AN:
    step(f"analyze {uid} {body[:40]}", uid, "POST", B + "/analyze", body, dt=11 if uid != 105 else 4)

# share
SH = [
    (101, None), (102, J({"days": 1})), (105, J({"days": 400})), (107, J({"days": "45"})), (109, J({"days": "4.5"})),
    (111, J({"days": None})), (113, J({"days": []})), (123, J({"days": True})), (103, '{"days": 1e400}'),
    (104, '{"days": ' + "1" + "0" * 400 + "}"), (106, '{"days": NaN}'), (108, J({"days": " 20 "})), (110, J({"days": 7.9})),
    (116, J({})), (112, J({"days": 7})), (114, J({"days": -5})), (115, J({"days": {"a": 1}})),
    (101, J({"days": 60})), (101, J({"days": 90})), (101, J({"days": 14})), (101, J({"days": 30})),
]
for uid, body in SH:
    step(f"share {uid} {str(body)[:30]}", uid, "POST", B + "/share", body if body is not None else "", dt=2,
         ctype="application/json" if body is not None else None)
step("share 101 after 10 min", 101, "POST", B + "/share", J({}), dt=601)

# feedback
FB = [
    (102, J({"type": "bug", "text": "Не работает кнопка на графике"})), (102, J({"type": " Idea ", "text": "  Хочу тёмную тему!  "})),
    (102, J({"type": "OTHER", "text": "x" * 10})), (102, J({"type": "feature", "text": "valid text here"})),
    (102, J({"type": None, "text": "valid text here"})), (102, J({"text": "valid text here"})),
    (102, J({"type": "bug", "text": "x" * 9})), (102, J({"type": "bug", "text": "   short   "})),
    (102, J({"type": "bug", "text": "x" * 2000})), (102, J({"type": "bug", "text": "x" * 2001})),
    (102, J({"type": "bug", "text": [1, 2, 3, 4, 5]})), (102, J({"type": "bug", "text": 123456789})),
    (102, '{"type": "bug", "text": 12345678.0}'), (102, J({"type": "bug", "text": {"a": "bbbbbbbbbb"}})),
    (102, J({"type": "bug", "text": True})), (104, J({"type": "bug", "text": "sixth today, limited"})),
    (106, J({"type": "idea", "text": "hostile counter value"})), (108, J({"type": "other", "text": "fifth of the day"})),
    (108, J({"type": "other", "text": "sixth of the day"})), (105, J({"type": "bug", "text": "😀" * 10})),
    (105, J({"type": "bug", "text": "😀" * 2001})), (105, '{"type": "bug", "text": "\\ud83d\\ude00 lone \\ud800 surrogate"}'),
    (105, J({"type": ["bug"], "text": "list type value"})),
]
for uid, body in FB:
    step(f"feedback {uid} {body[:40]}", uid, "POST", B + "/feedback", body, dt=2)
step("feedback 108 next day", 108, "POST", B + "/feedback", J({"type": "bug", "text": "a new day, new quota"}), dt=86400)

# [STATS-HONEST 2026-10] user 117 (the bot test's grid): final / open_live / net R / first_ts / equity_net,
# open vs closed by `final`, r_now from sl0, `limit` / cost keys; costs from env; the fallback stats
for q in ("", "?status=open", "?status=closed", "?limit=3", "?limit=0", "?limit=500", "?status=closed&strategy=levels",
          "?status=open&strategy=SMC", "?limit=abc"):
    step(f"signals 117 honest {q}", 117, "GET", B + "/signals" + q, dt=2)
step("dashboard 117 honest", 117, "GET", B + "/dashboard", dt=3)
step("stats 117 honest", 117, "GET", B + "/stats", dt=2)
step("share 117 honest", 117, "POST", B + "/share", J({"days": 30}), dt=2)
for env in ({"SIGNAL_STATS_COST_PCT": "0.3", "SIGNAL_STATS_EXCHANGE_COST_PCT": "0"},
            {"SIGNAL_STATS_COST_PCT": "garbage", "SIGNAL_STATS_EXCHANGE_COST_PCT": "-1"},
            {"SIGNAL_STATS_COST_PCT": "0", "SIGNAL_STATS_EXCHANGE_COST_PCT": "1_0"},
            {"SIGNAL_STATS_COST_PCT": "-0", "SIGNAL_STATS_EXCHANGE_COST_PCT": "inf"}):
    step(f"signals 117 honest env {env}", 117, "GET", B + "/signals?status=closed", dt=2, sets={"env": env})
    step(f"dashboard 117 honest env {env}", 117, "GET", B + "/dashboard", dt=2)
step("share 117 honest env", 117, "POST", B + "/share", J({"days": 7}), dt=2)
step("signals 117 honest env reset", 117, "GET", B + "/signals", dt=2,
     sets={"env": {"SIGNAL_STATS_COST_PCT": None, "SIGNAL_STATS_EXCHANGE_COST_PCT": None}})
step("dashboard 117 honest stats raise", 117, "GET", B + "/dashboard", dt=2, sets={"stats_raise": True})
step("dashboard 101 honest stats back", 101, "GET", B + "/dashboard", dt=2, sets={"stats_raise": False})


# ── unit vectors: yarl's reading of targets, json.loads types of body values ─
def unit_vectors():
    from yarl._quoters import PATH_SAFE_UNQUOTER, UNQUOTER_PLUS
    from yarl._parse import query_to_pairs
    from aiohttp.web_urldispatcher import _unquote_path_safe
    raw = ["abc", "a%2Fb", "a%2fb", "a%zzb", "%ff", "%D1%82%D0%B5%D1%81%D1%82", "a+b", "%25", "%252F", "%%2F", "%2%2F",
           "%e2%82", "%e2%82%ac", "%E2%82%ACx", "%c3%28", "%ed%a0%80", "%f0%9f%98%80", "%f4%90%80%80", "%c0%af", "%", "%4",
           "%41%42", "a%00b", "%7B", "%e2%2F", "%f0%9f%98", "%f0%9f%98a", "x%e2%82%acy%ff%fez", "%2e%2E", "%3B%3d%26%2B",
           "%e0%a0%80", "%e0%80%80", "%ef%bf%bf", "%f0%90%80%80", "%c2%80%c2"]
    paths = [{"raw": r, "safe": PATH_SAFE_UNQUOTER(r), "param": _unquote_path_safe(PATH_SAFE_UNQUOTER(r)),
              "plus": UNQUOTER_PLUS(r)} for r in raw]
    qs = ["", "a=1", "a=1&a=2", "a", "=x", "a=b=c", "&&a=1&&", "a=1;b=2", "a+b=c+d", "a%20b=%2B", "k=%zz", "k=%ff",
          "k=%e2%82%ac&k2=%e2%82", "%61=1", "k=%", "k=a%2", "status=open%26limit%3D3", "status%3Dopen", "k=%00",
          "a=1&", "&", "==", "k=%C5%BF", "x=%E2%80%83y"]
    queries = [{"raw": q, "pairs": [list(p) for p in query_to_pairs(q)]} for q in qs]
    bodies = ['{"v": 10}', '{"v": 10.0}', '{"v": 1e14}', '{"v": 1e16}', '{"v": 1e-7}', '{"v": -0.0}', '{"v": -0}',
              '{"v": 1e400}', '{"v": -1e400}', '{"v": NaN}', '{"v": Infinity}', '{"v": true}', '{"v": false}',
              '{"v": null}', '{"v": []}', '{"v": [1, 2.5, "x", null, true]}', '{"v": {"a": "b\'c", "d": [{}]}}',
              '{"v": ""}', '{"v": "  x  "}', '{"v": "a\\u0000b"}', '{"v": "\\ud800"}', '{"v": "\\ud83d\\ude00"}',
              '{"v": ' + "1" + "0" * 30 + '}', '{"v": -' + "9" * 40 + '}', '{"v": 123456789012345678901234567890.5}',
              '{"v": "45"}', '{"v": " 7 "}', '{"v": "4.5"}', '{"v": "1_000"}', '{"v": "\\u0663"}', '{"v": 7.9}', '{"v": -7.9}',
              '{"v": 0.5}', '{"v": "x\\ty\\n"}', '{"v": {"k": 1, "k": 2}}', '{"v": 1, "v": "dup"}', '{"w": 1}',
              '{"v": ["\\u00e9", "\\u0085", "\\u200b", "\\ud83d\\ude00"]}', '{"v": 2.675}', '{"v": 1.0e2}']
    vec = []
    for b in bodies:
        d = json.loads(b)
        rec = {"text": b, "present": "v" in d}
        if "v" in d:
            v = d["v"]
            rec["str"] = str(v)
            rec["truthy"] = bool(v)
            try:
                rec["int"] = str(int(v))
            except Exception as e:      # noqa: BLE001
                rec["int_exc"] = type(e).__name__
        vec.append(rec)
    return {"paths": paths, "queries": queries, "bodies": vec}


# ── run ─────────────────────────────────────────────────────────────────────
async def main():
    await database.init_db(DBP)
    con = sqlite3.connect(DBP)
    for uid, plan, status, exp, lang, _admin in USERS:
        con.execute("INSERT OR REPLACE INTO users (user_id, username, sub_plan, sub_status, sub_expires, lang) VALUES (?, ?, ?, ?, ?, ?)",
                    (uid, f"user{uid}", plan, status, NOW + exp if exp else 0, lang))
    for r in trades:
        con.execute(f"INSERT INTO trades ({', '.join(TRADE_COLS)}) VALUES ({', '.join('?' * len(TRADE_COLS))})",
                    [r.get(c) for c in TRADE_COLS])
    for e in EVENTS:
        con.execute("INSERT INTO trade_events (trade_id, ts, event_type, payload_json) VALUES (?, ?, ?, ?)",
                    (e["trade_id"], e["ts"], e["event_type"], e["payload_json"]))
    for k, v in KV.items():
        con.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", (k, v))
    con.commit()
    cache.init_cache(4000)
    for c in CACHE_SEED:
        await cache.set_candles(c["symbol"], c["tf"], to_df(frame_bars(c)), {c["tf"]: 10 * 86400})
    app = web.Application()
    api.register(app, bot=None, um=UserManager(), scanner=FakeScanner())
    server = TestServer(app)
    await server.start_server()
    port = server.port
    out = []
    for s in STEPS:
        CLOCK[0] = s["now"]
        st = s["set"]
        if "tickers" in st:
            STATE["tickers"].update(st["tickers"])
        if "rest" in st:
            STATE["rest"].update(st["rest"])
        if "trend_raw" in st:
            STATE["trend_raw"] = st["trend_raw"]
        if "env" in st:                        # [STATS-HONEST] SIGNAL_STATS_* read on every call
            for k, v in st["env"].items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        if "stats_raise" in st:
            STATE["stats_raise"] = st["stats_raise"]
        if "trend_state" in st:
            tm._state.clear()
            tm._state.update(json.loads(json.dumps(st["trend_state"])))
            tm._strength.clear()
            tm._strength.update(st.get("trend_strength") or {})
        RENDERS.clear()
        SHARES.clear()
        LOGS.lines.clear()
        status, headers, text = await raw_request(port, s["method"], s["path"], s["uid"], s["body"], s["ctype"])
        for _ in range(3):
            await asyncio.sleep(0.01)          # emit_bg trade_events tasks
        try:                                   # the PNG itself is not part of the comparison (D3)
            doc = json.loads(text)
            if isinstance(doc, dict) and isinstance(doc.get("png"), str):
                # a constant marker: matplotlib's PNG bytes (and so their length) differ run to run
                doc["png"] = "<png b64>"
                text = json.dumps(doc)
        except ValueError:
            pass
        con2 = sqlite3.connect(DBP)
        rec = {**s, "status": status, "headers": {k: headers[k] for k in ("retry-after", "allow", "content-type") if k in headers},
               "text": text, "renders": json.loads(json.dumps(RENDERS)), "shares": json.loads(json.dumps(SHARES)),
               "logs": list(LOGS.lines)}
        if s["uid"] is not None:
            rec["kv"] = kv_snapshot(con2, s["uid"])
        if s.get("trade"):
            rec["trade_state"] = trade_snapshot(con2, s["trade"])
        if s["path"].endswith("/feedback"):
            rows = con2.execute("SELECT id, user_id, type, text FROM feedback ORDER BY id").fetchall()
            rec["feedback_rows"] = [list(r) for r in rows]
        con2.close()
        out.append(rec)
    await server.close()
    fixture = {
        "units": unit_vectors(),
        "now": NOW, "users": USERS, "trades": trades, "trade_cols": TRADE_COLS, "events": EVENTS, "kv": KV,
        "cache_seed": CACHE_SEED, "rest_seed": REST_SEED, "tickers": TICKERS, "trend_raw": TREND_RAW,
        "steps": out,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with gzip.open(OUT, "wt", encoding="utf-8") as fh:
        json.dump(fixture, fh, ensure_ascii=True, allow_nan=True)
    print(len(trades), "trades,", len(out), "steps →", OUT)
    bad = [(r["name"], len(r["renders"])) for r in out for x in r["renders"] if bool(x["mirror"]) != x["png"]]
    print("render/mirror None mismatches:", bad)


asyncio.run(main())
sys.stdout.flush()
os._exit(0)      # aiosqlite's reader threads would keep the interpreter alive
