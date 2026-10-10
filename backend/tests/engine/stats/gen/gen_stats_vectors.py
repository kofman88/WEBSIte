"""gen_stats_vectors.py — real outputs of the bot's db/signal_outcome.py, db/signal_stats.py,
db/stats.py and the Mini App stats / signals helpers for the JS parity tests
(backend/tests/engine/stats/*.test.js).

Run with the bot's venv (cwd = the bot checkout is set by the script itself):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python gen_stats_vectors.py [OUT]
  ([OUT] defaults to the shipped fixture; a relative path resolves against the caller's cwd)
(afterwards: rm -f <bot>/signal_registry.json)

time.time() is pinned to NOW so every function that reads the clock sees the same instant
the JS side passes as `now`. The seeded DB is a fresh bot schema (database.init_db) in a
temp dir; the same rows are inserted on the JS side into signal_trades / trader_settings.

[STATS-HONEST 2026-10] (bot 7e20066 + 51e8256): every status row also carries has_real_result /
is_exchange_result / is_final / stop_pct / row_cost_r / net_rr; `stop` = stop_pct edge rows;
`honest` = the bot test's grid (entry 100, SL 99.4 → 0.25R / 0.20R costs) with manual «Пропустил»
rows over tracker stages: aggregate (30 / 7 d, the _COLS projection), rating_from_rows, _signal,
and aggregate / cost_pct / exchange_cost_pct under 20 SIGNAL_STATS_* env values; the seeded DB
gets the same grid for user 110 plus manual skips / exchange TP1 and BE rows for 101 (appended
after the shuffle, no rng); per user `live` = _user_signals + _attach_live over faked
signal_freshness.get_current_price, `env` = the lists and signal_stats under cost 0.3 /
exchange 0; `dashboard_fallback` = h_dashboard's stats when signal_stats raises.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import sqlite3
import sys
import tempfile
import time as _time
from types import SimpleNamespace

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
_CWD = os.getcwd()   # caller cwd: relative paths below resolve against it, not against the bot dir
os.chdir(BOT)
sys.path.insert(0, BOT)
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")

NOW = 1_766_000_000.0          # 2025-12-17 19:33:20 UTC (a Wednesday)
_REAL_TIME = _time.time

import faulthandler  # noqa: E402
faulthandler.dump_traceback_later(90, exit=True)

import database  # noqa: E402
import miniapp_api  # noqa: E402
from db import signal_outcome as so  # noqa: E402
from db import signal_stats as ss  # noqa: E402
from db import stats as dbs  # noqa: E402

OUT = os.path.join(_CWD, sys.argv[1]) if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "stats_vectors.json")
rng = random.Random(20261008)
out: dict = {"now": NOW}

# ── 1. signal_status / signal_rr on hand-made + random rows ─────────────────
STATUSES = ("tp1", "tp2", "tp3", "sl", "be", "missed", "expired", "open", "closed", "skip")
RESULTS = ["", "TP1", "TP2", "TP3", "SL", "BE", "MANUAL", "TRAIL", "SKIP", "ORPHAN", "CLOSED",
           "CANCELLED", None, "tp1", "sl", "skip"]
STAGES = ["", "ENTRY", "TP1", "TP2", "TP3", "SL", "BE", "EXPIRED", "MISSED", None, "tp2", "missed"]
status_rows = [
    {},
    {"result": "TP2", "progress_stage": "SL"},
    {"result": "MANUAL", "progress_stage": "TP1", "result_rr": 0.7},
    {"result": "SKIP", "skip_reason": "manual", "progress_stage": "TP3", "signal_msg_id": 5},
    {"result": "SKIP", "skip_reason": "ghost", "progress_stage": "TP3", "signal_msg_id": 5},
    {"result": "SKIP", "signal_msg_id": 0, "order_id": ""},
    {"result": "SKIP", "signal_msg_id": 0, "order_id": "o1"},
    {"result": "SKIP", "signal_msg_id": 9, "created_at": NOW - 10},
    {"result": "SKIP", "signal_msg_id": "x", "created_at": NOW - 10},
    {"result": "SKIP", "signal_msg_id": "12", "created_at": NOW - 10},
    {"result": "SKIP", "signal_msg_id": -3, "order_id": "  "},
    {"result": "ORPHAN", "progress_stage": "EXPIRED", "expire_rr": 0.555},
    {"result": "ORPHAN"},
    {"result": "CLOSED", "result_rr": "1.25"},
    {"result": "CANCELLED", "result_rr": ""},
    {"progress_stage": "EXPIRED", "expire_rr": "1.234"},
    {"progress_stage": "EXPIRED", "expire_rr": "bad"},
    {"progress_stage": "EXPIRED", "expire_rr": ""},
    {"progress_stage": "MISSED", "result": "ORPHAN"},
    {"created_at": NOW - 72 * 3600}, {"created_at": NOW - 72 * 3600 - 1}, {"created_at": "abc"},
    {"created_at": None}, {"created_at": 0}, {"created_at": NOW + 50},
    {"result": "TP1", "entry": 100, "sl": 95, "tp1": 110},
    {"result": "TP1", "entry": 100, "sl": 95, "tp1": 110, "result_rr": 0},
    {"result": "TP1", "entry": 100, "sl": 95, "tp1": 110, "result_rr": None},
    {"result": "TP1", "entry": 100, "sl": 95, "tp1": 110, "result_rr": "x"},
    {"progress_stage": "TP2", "entry": 100, "sl": 100, "original_sl": 96, "tp2": 120},
    {"progress_stage": "TP2", "entry": 100, "sl": 100, "original_sl": 0, "tp2": 120},
    {"progress_stage": "TP3", "entry": "100", "sl": "95", "tp3": "123.3"},
    {"progress_stage": "TP3", "entry": "x", "sl": "95", "tp3": "123.3"},
    {"progress_stage": "TP1", "entry": 100, "sl": 95, "tp1": 0},
    {"progress_stage": "TP1", "entry": 0.0123, "sl": 0.0119, "original_sl": 0.0118, "tp1": 0.0131},
    {"progress_stage": "SL", "result": "", "result_rr": 3.0},
    {"progress_stage": "BE", "result": "TRAIL", "result_rr": 0.4},
]
for _ in range(110):
    r = {}
    if rng.random() < 0.85:
        r["result"] = rng.choice(RESULTS)
    if rng.random() < 0.85:
        r["progress_stage"] = rng.choice(STAGES)
    if rng.random() < 0.4:
        r["skip_reason"] = rng.choice(["", "manual", "ghost", None, "not_delivered"])
    if rng.random() < 0.7:
        r["signal_msg_id"] = rng.choice([0, 0, 5, 77, None, "7", "x", -1])
    if rng.random() < 0.7:
        r["order_id"] = rng.choice(["", "", "o1", None, "  ", "123"])
    r["created_at"] = rng.choice([NOW - rng.uniform(0, 100) * 3600, NOW - 72 * 3600, 0, None, NOW - 5])
    if rng.random() < 0.5:
        r["result_rr"] = rng.choice([None, "", 0, 0.0, 1.5, -1.0, "2.5", "x", rng.uniform(-1, 4)])
    if rng.random() < 0.4:
        r["expire_rr"] = rng.choice([None, "", 0.555, -0.125, "1.234", "bad", rng.uniform(-1, 3)])
    d = rng.choice(["LONG", "SHORT"])
    s = 1 if d == "LONG" else -1
    e = rng.choice([100.0, 0.01234, 65432.1, 2.5])
    risk = e * rng.uniform(0.004, 0.03)
    r.update({"direction": d, "entry": e, "sl": e - s * risk, "tp1": e + s * risk * rng.uniform(1, 2),
              "tp2": e + s * risk * rng.uniform(2, 3.5), "tp3": e + s * risk * rng.uniform(3.5, 6)})
    if rng.random() < 0.4:
        r["original_sl"] = rng.choice([None, 0, e - s * risk * 1.2, e - s * risk * 0.8])
    if rng.random() < 0.15:
        r["sl"] = e     # moved to break-even
    status_rows.append(r)
out["status"] = []
for r in status_rows:
    st = so.signal_status(r, NOW)
    rr_ = so.signal_rr(r, st)
    out["status"].append({"row": r, "status": st, "rr": rr_,
                          "rr_by": {s: so.signal_rr(r, s) for s in STATUSES},
                          "has_card": so.has_card(r), "exchange": so.is_exchange_trade(r),
                          # [STATS-HONEST 2026-10]
                          "real": so.has_real_result(r), "ex_result": so.is_exchange_result(r),
                          "final": so.is_final(r, st), "final_by": {s: so.is_final(r, s) for s in STATUSES},
                          "stop_pct": ss.stop_pct(r), "cost_r": ss.row_cost_r(r),
                          "cost_r_x": ss.row_cost_r(r, 0.2, 0.05), "net": ss.net_rr(r, rr_),
                          "net_x": ss.net_rr(r, 1.5, 0.0, 0.3)})
out["countable_sql"] = so.COUNTABLE_SQL
out["max_age_s"] = so.MAX_AGE_S

# ── 1b. [STATS-HONEST] stop_pct / row_cost_r / net_rr edge rows ─────────────
STOP_ROWS = [
    {"entry": 100, "sl": 99.4}, {"entry": 100, "sl": 100, "original_sl": 99.4}, {"entry": 100, "sl": 99.4, "original_sl": 0},
    {"entry": 100, "sl": 99.4, "original_sl": None}, {"entry": 100, "sl": 99.4, "original_sl": -0.0},
    {"entry": 100, "sl": 100}, {"entry": 0, "sl": 99}, {"entry": -5, "sl": -6}, {"entry": 100, "sl": -1},
    {"entry": 100, "sl": 0, "original_sl": 0}, {"entry": "100", "sl": "99.5"}, {"entry": " 100 ", "sl": "1_00.5"},
    {"entry": "x", "sl": 99}, {"entry": 100, "sl": "x"}, {"entry": 100, "original_sl": "bad", "sl": 99},
    {"entry": "inf", "sl": 99}, {"entry": 100, "sl": "-inf"}, {"entry": "nan", "sl": 99}, {"entry": 100, "original_sl": "nan", "sl": 99},
    {"entry": 100, "original_sl": True, "sl": 99}, {"entry": True, "sl": 0.5}, {"entry": 1e-300, "sl": 2e-300},
    {"entry": 65432.1, "sl": 65431.1}, {"entry": 0.00012, "sl": 0.000119}, {"entry": 1e300, "sl": 5e299}, {},
    {"entry": 100, "sl": 99.4, "order_id": "o1", "result": "TP1", "result_rr": 0.95},
    {"entry": 100, "sl": 99.4, "order_id": "o1", "result": "TP1", "result_rr": ""},
    {"entry": 100, "sl": 99.4, "order_id": "o1", "result": "TP1", "result_rr": None},
    {"entry": 100, "sl": 99.4, "order_id": "o1", "result": "SKIP", "result_rr": 0.0},
    {"entry": 100, "sl": 99.4, "order_id": "o1", "result": "orphan", "result_rr": 1.0},
    {"entry": 100, "sl": 99.4, "order_id": " ", "result": "SL", "result_rr": -1.0},
    {"entry": 100, "sl": 99.4, "order_id": "", "result": "TP2", "result_rr": 2.9},
    {"entry": 100, "sl": 99.4, "order_id": 7, "result": "manual", "result_rr": "0.4"},
    {"entry": 100, "sl": 99.4, "order_id": "o2", "result": 0, "result_rr": 1.0},
]
out["stop"] = [{"row": r, "stop_pct": ss.stop_pct(r), "cost_r": ss.row_cost_r(r), "cost_r_x": ss.row_cost_r(r, 0.0, 0.5),
                "net_1": ss.net_rr(r, 1.0), "net_none": ss.net_rr(r, None), "net_str": ss.net_rr(r, "2.5"),
                "ex_result": so.is_exchange_result(r), "real": so.has_real_result(r)} for r in STOP_ROWS]
out["defaults"] = {"cost_pct": ss.DEFAULT_COST_PCT, "exchange_cost_pct": ss.DEFAULT_EXCHANGE_COST_PCT, "cols": ss._COLS}

# ── 2. a seeded DB with the bot schema ──────────────────────────────────────
tmp = tempfile.mkdtemp(prefix="m10a_stats_")
DBP = os.path.join(tmp, "bot.db")
LOOP = asyncio.new_event_loop()
asyncio.set_event_loop(LOOP)
LOOP.run_until_complete(database.init_db(DBP))

USERS = [(101, "pro"), (102, "pro"), (103, "free"), (104, "pro"), (105, "free"), (106, "pro"), (107, "pro")]
SYMS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "PEPE-USDT-SWAP", "DOGE-USDT", "XRP-USDT-SWAP"]
STRATS = ["LEVELS", "SMC", "VOLUME", "LEVELS", "SMC", "", "GERCHIK", "smc", "SCALP"]
TFS = ["15m", "1h", "4h", "1H", "30m", "1d"]
CTX = ["", "", "aligned", "with", "counter", "strong_counter"]
trades: list[dict] = []
seq = 0


def mk_levels(direction, entry):
    s = 1 if direction == "LONG" else -1
    risk = entry * rng.uniform(0.004, 0.02)
    return {"entry": entry, "sl": entry - s * risk, "original_sl": entry - s * risk,
            "tp1": entry + s * risk * rng.choice([1.0, 1.5, 2.0]), "tp2": entry + s * risk * rng.choice([2.5, 3.0]),
            "tp3": entry + s * risk * rng.choice([4.0, 4.5, 5.0])}


def outcome(r):
    """Random but realistic outcome of a row (signal stage or exchange result)."""
    kind = rng.random()
    if kind < 0.18:      # exchange trade
        r["order_id"] = f"ox{rng.randint(1, 10**6)}"
        r["result"] = rng.choice(["", "TP1", "TP2", "TP3", "SL", "SL", "BE", "MANUAL", "TRAIL", "CLOSED", "SKIP"])
        r["result_rr"] = {"": 0, "TP1": 1.5, "TP2": 2.7, "TP3": 4.4, "SL": -1.0, "BE": 0.0,
                          "MANUAL": rng.choice([0.6, -0.4, 0.0]), "TRAIL": 1.9, "CLOSED": 0.33, "SKIP": 0}[r["result"]]
        r["signal_msg_id"] = rng.choice([0, 11])
        if r["result"] not in ("", "SKIP") and rng.random() < 0.6:
            r["closed_pnl_usd"] = round(rng.uniform(-30, 60), 2)
        if rng.random() < 0.2:
            r["progress_stage"] = rng.choice(["TP1", "SL"])
    elif kind < 0.25:    # ghost / not delivered
        r["result"] = "SKIP"
        r["skip_reason"] = rng.choice(["ghost", "not_delivered"])
        r["signal_msg_id"] = rng.choice([0, 0, 21])
    elif kind < 0.28:    # orphan
        r["result"] = "ORPHAN"
    elif kind < 0.33:    # manual result
        r["signal_msg_id"] = 31
        r["result"] = rng.choice(["TP1", "TP2", "SL", "BE", "SKIP"])
        r["result_rr"] = {"TP1": 2.0, "TP2": 3.0, "SL": -1.0, "BE": 0.0, "SKIP": 0.0}[r["result"]]
        if r["result"] == "SKIP":
            r["skip_reason"] = "manual"
    else:                # tracked signal
        r["signal_msg_id"] = rng.randint(1, 999)
        r["progress_stage"] = rng.choice(["", "", "ENTRY", "TP1", "TP1", "TP2", "TP3", "SL", "SL", "BE", "EXPIRED", "MISSED"])
        if r["progress_stage"] == "EXPIRED":
            r["expire_rr"] = rng.choice([None, round(rng.uniform(-1, 2.5), 2)])
        if rng.random() < 0.1:
            r["result"] = "SKIP"
            r["skip_reason"] = "ghost"


def add_trade(uid, base, created_at, strategy):
    global seq
    seq += 1
    r = {"trade_id": f"t{seq:04d}_{uid}", "user_id": uid, "symbol": base["symbol"], "direction": base["direction"],
         **base["levels"], "created_at": created_at, "strategy": strategy, "timeframe": base["timeframe"],
         "quality": rng.randint(0, 10), "trend_ctx": base["ctx"], "mtf_aligned": base["mtf"],
         "is_counter_trend": base["counter"], "breakout_type": rng.choice(["", "SMC", "pivot", "SCALP"]),
         "result": "", "result_rr": 0, "order_id": "", "signal_msg_id": 0, "progress_stage": "",
         "skip_reason": "", "user_note": rng.choice(["", "", "нота"])}
    outcome(r)
    trades.append(r)


# shared signals: the same signal delivered to several users (rating / pro overview dedup)
for k in range(70):
    d = rng.choice(["LONG", "SHORT"])
    base = {"symbol": rng.choice(SYMS), "direction": d,
            "levels": mk_levels(d, rng.choice([100.0, 2.5, 65000.0, 0.00123])),
            "timeframe": rng.choice(TFS), "ctx": rng.choice(CTX), "mtf": rng.choice([0, 0, 1]), "counter": rng.choice([0, 0, 1])}
    created = NOW - rng.uniform(0, 40 * 86400)
    strat = rng.choice(STRATS)
    for uid, _plan in rng.sample(USERS, rng.randint(1, 5)):
        add_trade(uid, base, created + rng.uniform(0, 600), strat)
# per-user private signals
for uid, _plan in USERS:
    for _ in range(rng.randint(10, 35)):
        d = rng.choice(["LONG", "SHORT"])
        base = {"symbol": rng.choice(SYMS), "direction": d,
                "levels": mk_levels(d, rng.choice([100.0, 2.5, 65000.0, 0.00123])),
                "timeframe": rng.choice(TFS), "ctx": rng.choice(CTX), "mtf": rng.choice([0, 1]), "counter": rng.choice([0, 1])}
        add_trade(uid, base, NOW - rng.uniform(0, 45 * 86400), rng.choice(STRATS))
# a user with exactly one recent loss (EV insufficient), a user with only TP1/TP2 stages (double count)
add_trade(108, {"symbol": "ADA-USDT-SWAP", "direction": "LONG", "levels": mk_levels("LONG", 1.0), "timeframe": "1h",
                "ctx": "", "mtf": 0, "counter": 0}, NOW - 3600, "LEVELS")
USERS.append((108, "free"))
for st_ in ("TP1", "TP2", "TP1"):
    seq += 1
    trades.append({"trade_id": f"t{seq:04d}_109", "user_id": 109, "symbol": "BNB-USDT-SWAP", "direction": "SHORT",
                   "entry": 500.0, "sl": 510.0, "original_sl": 510.0, "tp1": 485.0, "tp2": 470.0, "tp3": 450.0,
                   "created_at": NOW - seq * 600, "strategy": "VOLUME", "timeframe": "4h", "quality": 3,
                   "trend_ctx": "", "mtf_aligned": 0, "is_counter_trend": 0, "breakout_type": "VOLUME",
                   "result": "", "result_rr": 0, "order_id": "", "signal_msg_id": 4, "progress_stage": st_,
                   "skip_reason": "", "user_note": ""})
USERS.append((109, "pro"))
# never-delivered signals (ghost branch a) and an undelivered exchange-less row with a NULL msg id
for k, (age_h, msg) in enumerate(((1, 0), (30, 0), (100, 0), (200, None), (5, 3))):
    seq += 1
    trades.append({"trade_id": f"t{seq:04d}_105g", "user_id": 105, "symbol": "LTC-USDT-SWAP", "direction": "LONG",
                   "entry": 80.0, "sl": 78.0, "original_sl": 78.0, "tp1": 84.0, "tp2": 86.0, "tp3": 90.0,
                   "created_at": NOW - age_h * 3600, "strategy": "LEVELS", "timeframe": "1h", "quality": 5,
                   "trend_ctx": "", "mtf_aligned": 0, "is_counter_trend": 0, "breakout_type": "",
                   "result": "", "result_rr": 0, "order_id": "", "signal_msg_id": msg, "progress_stage": "",
                   "skip_reason": "", "user_note": ""})
rng.shuffle(trades)     # insertion order ≠ created_at order (natural scan order matters)

# [STATS-HONEST 2026-10] hand-made rows, appended after the shuffle (no rng): the bot test's grid
# (tests/test_signal_stats_honest_2026_10.py _rows: entry 100, SL 99.4, TP 1.0 / 2.9 / 3.9R) for user 110,
# manual «Пропустил» over tracker stages SL / '' / TP1 / MISSED and an exchange TP1 / BE pair for 101 and 110.
HCOLS = {"result": "", "result_rr": None, "progress_stage": "", "entry": 100.0, "sl": 99.4, "original_sl": None,
         "tp1": 100.6, "tp2": 101.74, "tp3": 102.34, "strategy": "VOLUME", "order_id": "", "signal_msg_id": 7,
         "symbol": "QNT-USDT-SWAP", "direction": "LONG", "expire_rr": None, "skip_reason": "", "timeframe": "15m",
         "quality": 4, "trend_ctx": "", "mtf_aligned": 0, "is_counter_trend": 0, "breakout_type": "", "user_note": ""}


def hrow(tid, now, **kw):
    r = {"trade_id": tid, **HCOLS, "created_at": now - 3600}
    r.update(kw)
    return r


def honest_grid(now, p=""):
    return [
        hrow(p + "tp1-open", now, progress_stage="TP1", sl=100.0, original_sl=99.4, created_at=now - 5 * 3600),
        hrow(p + "tp2-skip", now, progress_stage="TP2", result="SKIP", created_at=now - 4 * 3600),
        hrow(p + "tp3", now, progress_stage="TP3", created_at=now - 3 * 3600),
        hrow(p + "sl", now, progress_stage="SL", created_at=now - 2 * 3600),
        hrow(p + "be", now, progress_stage="BE", created_at=now - 3500),
        hrow(p + "exp", now, progress_stage="EXPIRED", expire_rr=0.4, created_at=now - 3 * 86400),
        hrow(p + "missed", now, progress_stage="MISSED", created_at=now - 2 * 86400),
        hrow(p + "ex-tp1", now, order_id="o-1", result="TP1", result_rr=0.95, strategy="LEVELS", progress_stage="TP1",
             created_at=now - 6 * 3600),
        hrow(p + "ex-be", now, order_id="o-2", result="BE", result_rr=0.02, strategy="LEVELS", created_at=now - 7 * 3600),
        hrow(p + "old-sl", now, progress_stage="SL", created_at=now - 10 * 86400),
        hrow(p + "manual-tp2", now, result="TP2", result_rr=2.9, created_at=now - 1800),
        hrow(p + "fresh", now, created_at=now - 600),
        # manual «Пропустил» (miniapp_api h_signal_result SKIP → skip_reason='manual') over tracker stages
        hrow(p + "ms-sl", now, result="SKIP", skip_reason="manual", progress_stage="SL", symbol="AAA-USDT-SWAP",
             created_at=now - 8 * 3600),
        hrow(p + "ms-open", now, result="SKIP", skip_reason="manual", symbol="BBB-USDT-SWAP", created_at=now - 9 * 3600),
        hrow(p + "ms-tp1", now, result="SKIP", skip_reason="manual", progress_stage="TP1", symbol="CCC-USDT-SWAP",
             strategy="SMC", created_at=now - 10 * 3600),
        hrow(p + "ms-missed", now, result="SKIP", skip_reason="manual", progress_stage="MISSED", symbol="DDD-USDT-SWAP",
             created_at=now - 11 * 3600),
        # unknown stop: SL at stage SL with no sl / original_sl → −1R gross and net
        hrow(p + "nostop", now, progress_stage="SL", sl=0.0, original_sl=0.0, symbol="EEE-USDT-SWAP",
             created_at=now - 12 * 3600),
    ]


for r in honest_grid(NOW, "h110-"):
    trades.append({**r, "user_id": 110})
for r in honest_grid(NOW, "h101-")[7:9] + honest_grid(NOW, "h101-")[12:16]:
    trades.append({**r, "user_id": 101, "symbol": "BTC-USDT-SWAP", "entry": 70000.0, "sl": 69580.0,
                   "tp1": 70420.0, "tp2": 71218.0, "tp3": 71638.0})
USERS.append((110, "pro"))

con = sqlite3.connect(DBP)
for uid, plan in USERS:
    con.execute("INSERT OR REPLACE INTO users (user_id, sub_plan) VALUES (?, ?)", (uid, plan))
COLS = sorted({k for r in trades for k in r})
for r in trades:
    con.execute(f"INSERT INTO trades ({', '.join(COLS)}) VALUES ({', '.join('?' * len(COLS))})",
                [r.get(c) for c in COLS])
con.commit()
plans_ = {"pro_overview_plan": con.execute(
    "EXPLAIN QUERY PLAN SELECT t.user_id FROM trades t JOIN users u ON u.user_id = t.user_id "
    "WHERE u.sub_plan='pro' AND t.created_at > ?", (0,)).fetchall()}
con.close()
out["users"] = USERS
out["trades"] = trades
out["insert_cols"] = COLS
out["plans"] = [list(x) for x in plans_["pro_overview_plan"]]


_time.time = lambda: NOW       # every bot module calls time.time() (pinned after init_db)

# [STATS-HONEST] signal_freshness.get_current_price (the WS candle cache in the bot) faked per symbol
PRICES = {"BTC-USDT-SWAP": 70123.5, "ETH-USDT-SWAP": None, "SOL-USDT-SWAP": 101.25, "PEPE-USDT-SWAP": "raise",
          "DOGE-USDT-SWAP": 0.0, "XRP-USDT-SWAP": 2.5, "QNT-USDT-SWAP": 100.3, "BNB-USDT-SWAP": 495.0,
          "ADA-USDT-SWAP": 1.02, "LTC-USDT-SWAP": 81.0, "BBB-USDT-SWAP": 101.0}
out["prices"] = PRICES
import signal_freshness  # noqa: E402


async def _fake_price(symbol):
    v = PRICES.get(symbol)
    if v == "raise":
        raise RuntimeError("price boom")
    return v


signal_freshness.get_current_price = _fake_price

# ── 1c. [STATS-HONEST] the bot test's grid: aggregate, _COLS projection, rating, _signal, env ──
HROWS = honest_grid(NOW)
_cols = [c.strip() for c in ss._COLS.split(",")]
ENVS = [{}, {"SIGNAL_STATS_COST_PCT": ""}, {"SIGNAL_STATS_COST_PCT": "0"}, {"SIGNAL_STATS_COST_PCT": "0.3"},
        {"SIGNAL_STATS_COST_PCT": "abc"}, {"SIGNAL_STATS_COST_PCT": "-1"}, {"SIGNAL_STATS_COST_PCT": "inf"},
        {"SIGNAL_STATS_COST_PCT": "nan"}, {"SIGNAL_STATS_COST_PCT": "-0"}, {"SIGNAL_STATS_COST_PCT": " 0.25 "},
        {"SIGNAL_STATS_COST_PCT": "1_0"}, {"SIGNAL_STATS_COST_PCT": "1e-1"}, {"SIGNAL_STATS_COST_PCT": "\u0663"},
        {"SIGNAL_STATS_COST_PCT": "0x10"}, {"SIGNAL_STATS_COST_PCT": "Infinity"},
        {"SIGNAL_STATS_EXCHANGE_COST_PCT": "0"}, {"SIGNAL_STATS_EXCHANGE_COST_PCT": "0.05"},
        {"SIGNAL_STATS_EXCHANGE_COST_PCT": "garbage"}, {"SIGNAL_STATS_EXCHANGE_COST_PCT": "-0.5"},
        {"SIGNAL_STATS_COST_PCT": "0.15", "SIGNAL_STATS_EXCHANGE_COST_PCT": "0.15"}]
env_out = []
for env in ENVS:
    os.environ.update(env)
    try:
        env_out.append({"env": env, "cost_pct": ss.cost_pct(), "exchange_cost_pct": ss.exchange_cost_pct(),
                        "aggregate": ss.aggregate(HROWS, 30, NOW),
                        "signals": [miniapp_api._signal(r) for r in HROWS[7:12]]})
    finally:
        for k in env:
            del os.environ[k]
out["honest"] = {
    "rows": HROWS,
    "status": {r["trade_id"]: so.signal_status(r, NOW) for r in HROWS},
    "final": {r["trade_id"]: so.is_final(r, so.signal_status(r, NOW)) for r in HROWS},
    "aggregate_30": ss.aggregate(HROWS, 30, NOW),
    "aggregate_7": ss.aggregate(HROWS, 7, NOW),
    "aggregate_cols": ss.aggregate([{k: r.get(k) for k in _cols} for r in HROWS], 30, NOW),
    "aggregate_no_skip": ss.aggregate([r for r in HROWS if r["skip_reason"] != "manual"], 30, NOW),
    "aggregate_empty": ss.aggregate([], 30, NOW),
    "rating": ss.rating_from_rows(HROWS, NOW),
    "signals": [miniapp_api._signal(r) for r in HROWS],
    "env": env_out,
}


async def collect():
    res = {"per_user": {}}
    for uid, _plan in USERS:
        u = {}
        u["signal_stats_30"] = await ss.signal_stats(uid, 30)
        u["signal_stats_7"] = await ss.signal_stats(uid, 7)
        u["rows_since"] = await ss.signal_rows_since(uid, NOW - 5 * 86400)
        u["dashboard"] = await dbs.db_dashboard_stats(uid, 30)
        u["dashboard_7"] = await dbs.db_dashboard_stats(uid, 7)
        u["auto"] = await dbs.db_get_auto_stats(uid)
        u["auto_1"] = await dbs.db_get_auto_stats_period(uid, 1)
        u["auto_7"] = await dbs.db_get_auto_stats_period(uid, 7)
        u["auto_30"] = await dbs.db_get_auto_stats_period(uid, 30)
        u["user_stats"] = await dbs.db_get_user_stats(uid)
        u["by_strategy"] = await dbs.db_get_user_stats_by_strategy(uid)
        u["sl_count_24"] = await dbs.db_get_recent_sl_count(uid, 24)
        u["sl_count_240"] = await dbs.db_get_recent_sl_count(uid, 240)
        u["ev_block"] = dbs.format_ev_block(u["user_stats"]) if u["user_stats"] else dbs.format_ev_block({})
        u["ev_short"] = {k: dbs.format_ev_short(v) for k, v in u["by_strategy"].items()}
        u["signals"] = {}
        for status in ("all", "open", "closed"):
            for strat in ("", "LEVELS", "SMC", "VOLUME", "bad"):
                for limit in (6, 50):
                    u["signals"][f"{status}|{strat}|{limit}"] = await miniapp_api._user_signals(uid, status, limit, strat)
        u["stats"] = {}
        for q in ({}, {"days": "7"}, {"days": "abc"}, {"days": "1000"}, {"days": "0"}, {"strategy": "SMC"},
                  {"strategy": "levels"}, {"strategy": "bad"}, {"tf": "1h"}, {"tf": "15M"}, {"tf": "4h", "strategy": "VOLUME"},
                  {"days": "365", "strategy": "LEVELS", "tf": "15m"}):
            async def _lu(_req, _uid=uid):
                return None, SimpleNamespace(user_id=_uid)
            miniapp_api._load_user = _lu
            resp = await miniapp_api.h_stats(SimpleNamespace(query=q))
            u["stats"][json.dumps(q, sort_keys=True)] = json.loads(resp.text)
        # [STATS-HONEST] _attach_live over a faked signal_freshness.get_current_price (risk from sl0)
        u["live"] = {}
        for status in ("all", "open"):
            sigs = await miniapp_api._user_signals(uid, status, 50, "")
            await miniapp_api._attach_live(sigs)
            u["live"][status] = sigs
        # [STATS-HONEST] cost env read per call: net_rr of the list and signal_stats under cost 0.3 / exchange 0
        os.environ["SIGNAL_STATS_COST_PCT"], os.environ["SIGNAL_STATS_EXCHANGE_COST_PCT"] = "0.3", "0"
        try:
            u["env"] = {"signals": await miniapp_api._user_signals(uid, "all", 50, ""),
                        "signal_stats_30": await ss.signal_stats(uid, 30)}
        finally:
            del os.environ["SIGNAL_STATS_COST_PCT"], os.environ["SIGNAL_STATS_EXCHANGE_COST_PCT"]
        res["per_user"][str(uid)] = u
    # h_dashboard when signal_stats raises: the fallback stats dict
    async def _boom(*_a, **_k):
        raise RuntimeError("stats boom")
    _orig_ss = miniapp_api._signal_stats
    miniapp_api._signal_stats = _boom

    async def _lu101(_req):
        return None, SimpleNamespace(user_id=101)
    miniapp_api._load_user = _lu101
    try:
        resp = await miniapp_api.h_dashboard(SimpleNamespace(query={}))
        res["dashboard_fallback"] = json.loads(resp.text)["stats"]
    finally:
        miniapp_api._signal_stats = _orig_ss
    res["pro_overview_7"] = await ss.pro_overview(7)
    res["pro_overview_30"] = await ss.pro_overview(30)
    res["pro_overview_1"] = await ss.pro_overview(1)
    res["rating_30"] = await ss.strategy_rating(30, force=True)
    res["rating_7"] = await ss.strategy_rating(7, force=True)
    res["rating_90"] = await ss.strategy_rating(90, force=True)
    return res

out.update(LOOP.run_until_complete(collect()))


# ── 2b. ghost cleanup (bot.py _ghost_cleanup_loop → db_cleanup_ghost_trades_all(3)) and the
#        cache_gc trades GC, on the same seeded DB, AFTER every read above ─────────────────
async def ghost():
    from db import trades as dbt
    snap = lambda: [dict(zip(("trade_id", "result", "state", "skip_reason", "state_changed_at"), r)) for r in  # noqa: E731
                    sqlite3.connect(DBP).execute(
                        "SELECT trade_id, result, state, skip_reason, state_changed_at FROM trades ORDER BY trade_id").fetchall()]
    res = {}
    res["one_user"] = list(await dbt.db_cleanup_ghost_trades(103, max_age_days=30))
    res["after_one_user"] = snap()
    res["all"] = list(await dbt.db_cleanup_ghost_trades_all(max_age_days=3))
    res["after_all"] = snap()
    con2 = sqlite3.connect(DBP)
    cur = con2.execute("DELETE FROM trades WHERE result IN ('SKIP','ORPHAN') AND created_at < ?", (NOW - 30 * 86400,))
    res["gc_deleted"] = cur.rowcount
    con2.commit()
    res["after_gc"] = [r[0] for r in con2.execute("SELECT trade_id FROM trades ORDER BY trade_id").fetchall()]
    con2.close()
    return res

out["ghost"] = LOOP.run_until_complete(ghost())

# ── 3. pure helpers on synthetic inputs ─────────────────────────────────────
out["normalize"] = {str(v): dbs.normalize_strategy(v) for v in
                    (None, "", "levels", " smc ", "VOLUME", "gerchik", "ГЕРЧИК", "gerch", "scalp", "SCALPING",
                     "liquidation", "foo", 0, "Smc")}
out["trade_strategy"] = [{"t": t, "s": dbs._trade_strategy(t)} for t in
                         ({}, {"strategy": "SMC"}, {"strategy": "", "breakout_type": "SMC"}, {"strategy": None, "breakout_type": "scalp"},
                          {"breakout_type": "pivot"}, {"strategy": "VOLUME", "breakout_type": "SMC"})]
ev_inputs = [
    [], [{"result": "TP1", "result_rr": 2.0}] * 4,
    [{"result": r, "result_rr": rr} for r, rr in (("TP1", 2.0), ("SL", -1.0), ("SL", -1.0), ("TP2", 3.0), ("BE", 0.0), ("MANUAL", 0.5))],
    [{"result": r, "result_rr": rr} for r, rr in (("SL", -1.0), ("SL", -1.0), ("SL", -1.0), ("TP1", 1.2), ("MANUAL", -0.3))],
    [{"result": r, "result_rr": rr} for r, rr in (("SL", -1.0), ("TP1", 1.0), ("SL", -1.0), ("TP1", 1.05), ("MANUAL", 0.0))],
    [{"result": "BE", "result_rr": 0.0}] * 6,
    [{"result": r, "result_rr": rr} for r, rr in (("TP1", 0.1), ("TP1", 0.2), ("TP1", 0.3), ("TP1", 0.1), ("SL", -0.35), ("CLOSED", 5))],
]
out["ev"] = [{"trades": t, "ev": dbs._ev_calc(t), "pnl": dbs._pnl_aggregate(t)} for t in ev_inputs]
out["ev_text"] = []
for st in ({}, {"ev_status": "insufficient_data", "closed_count": 0}, {"ev_status": "insufficient_data", "closed_count": 3},
           {"ev_status": "positive", "expectancy_r": 0.125, "avg_win_r": 2.0, "avg_loss_r": 1.0},
           {"ev_status": "positive", "expectancy_r": 1.0, "avg_win_r": 2.25, "avg_loss_r": 0.5},
           {"ev_status": "negative", "expectancy_r": -0.333, "avg_win_r": 1.1, "avg_loss_r": 1.0},
           {"ev_status": "breakeven", "expectancy_r": 0.0, "avg_win_r": 1.0, "avg_loss_r": 1.0},
           {"ev_status": "breakeven", "expectancy_r": -0.05, "avg_win_r": 0.95, "avg_loss_r": 1.0},
           {"ev_status": "positive", "expectancy_r": None}):
    out["ev_text"].append({"stats": st, "block": dbs.format_ev_block(st), "short": dbs.format_ev_short(st)})
out["help_text"] = dbs.STATS_HELP_TEXT_RU
out["sessions"] = {str(h): __import__("cohort_stats")._session_for_hour(h) for h in range(24)}

json.dump(out, open(OUT, "w"), ensure_ascii=False, indent=0, default=float)
print("written", OUT, len(trades), "trades", out["plans"])
sys.stdout.flush()
os._exit(0)   # aiosqlite pool threads would keep the interpreter alive
