"""gen_stats_vectors.py — real outputs of the bot's db/signal_outcome.py, db/signal_stats.py,
db/stats.py and the Mini App stats / signals helpers for the JS parity tests
(backend/tests/engine/stats/*.test.js).

Run with the bot's venv (cwd = the bot checkout is set by the script itself):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python gen_stats_vectors.py OUT.json
(afterwards: rm -f <bot>/signal_registry.json)

time.time() is pinned to NOW so every function that reads the clock sees the same instant
the JS side passes as `now`. The seeded DB is a fresh bot schema (database.init_db) in a
temp dir; the same rows are inserted on the JS side into signal_trades / trader_settings.
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

OUT = sys.argv[1] if len(sys.argv) > 1 else "stats_vectors.json"
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
    out["status"].append({"row": r, "status": st, "rr": so.signal_rr(r, st),
                          "rr_by": {s: so.signal_rr(r, s) for s in STATUSES},
                          "has_card": so.has_card(r), "exchange": so.is_exchange_trade(r)})
out["countable_sql"] = so.COUNTABLE_SQL
out["max_age_s"] = so.MAX_AGE_S

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
rng.shuffle(trades)     # insertion order ≠ created_at order (natural scan order matters)

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
        res["per_user"][str(uid)] = u
    res["pro_overview_7"] = await ss.pro_overview(7)
    res["pro_overview_30"] = await ss.pro_overview(30)
    res["pro_overview_1"] = await ss.pro_overview(1)
    res["rating_30"] = await ss.strategy_rating(30, force=True)
    res["rating_7"] = await ss.strategy_rating(7, force=True)
    res["rating_90"] = await ss.strategy_rating(90, force=True)
    return res

out.update(LOOP.run_until_complete(collect()))

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
