"""gen_stats_rand.py — 500 random trades (12 users) seeded into a fresh bot-schema SQLite and
run through the bot's db/signal_stats.py, db/stats.py and miniapp_api.h_stats /
_user_signals with time.time pinned to NOW. The same rows go into signal_trades /
trader_settings on the JS side (backend/tests/engine/stats/statsRand.test.js).

Adversarial on purpose: created_at ties and the exact 7 / 30 / 90-day boundaries, the same
signal delivered to several users with DIFFERENT outcomes (first-known-R dedup), random
result_rr with many decimals and .xx5 halves (sums, banker's rounding), lowercase / legacy /
NULL strategies and results, manual SKIP over a tracker stage, ghost SKIP with and without a
card, ORPHAN, whitespace order ids, '-USDT' / bare symbols, closed_pnl_usd on some rows,
plans 'pro' / 'free' / 'trial' / ''.

  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python gen_stats_rand.py [OUT]
  ([OUT] defaults to the shipped fixture; a relative path resolves against the caller's cwd)
  (afterwards: rm -f <bot>/signal_registry.json)
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

NOW = 1_767_225_600.0 + 13 * 3600 + 7.25     # 2026-01-01 13:00:07.25 UTC (a Thursday)

import database  # noqa: E402
import miniapp_api  # noqa: E402
from db import signal_stats as ss  # noqa: E402
from db import stats as dbs  # noqa: E402

OUT = os.path.join(_CWD, sys.argv[1]) if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "stats_rand.json")
rng = random.Random(500500)

tmp = tempfile.mkdtemp(prefix="m10a_stats_rand_")
DBP = os.path.join(tmp, "bot.db")
LOOP = asyncio.new_event_loop()
asyncio.set_event_loop(LOOP)
LOOP.run_until_complete(database.init_db(DBP))

USERS = [(301, "pro"), (302, "pro"), (303, "free"), (304, "pro"), (305, "trial"), (306, "pro"),
         (307, "free"), (308, ""), (309, "pro"), (310, "pro"), (311, "free"), (312, "pro")]
UIDS = [u for u, _ in USERS]
SYMS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT", "PEPE-USDT-SWAP", "DOGE", "XRP-USDT-SWAP", "ADA-USDT-SWAP"]
STRATS = ["LEVELS", "SMC", "VOLUME", "levels", "Smc", "", None, "GERCHIK", "scalp", "foo"]
TFS = ["15m", "1h", "4h", "1H", "15M", "1d", "", None, "30m"]
CTX = ["", "aligned", "with", "counter", "strong_counter", None, "weird"]
RR_POOL = [0.125, 0.375, 2.675, 1.005, 0.015, -0.125, 0.1 + 0.2, 1 / 3, -1.0, 0.0, 2.5, 4.4]
trades: list = []
seq = 0


def levels(direction, entry):
    s = 1 if direction == "LONG" else -1
    risk = entry * rng.choice([0.01, 0.0125, 0.02, rng.uniform(0.003, 0.03)])
    lv = {"entry": entry, "sl": entry - s * risk, "tp1": entry + s * risk * rng.choice([1.0, 1.5, 1.25, 2.0]),
          "tp2": entry + s * risk * rng.choice([2.5, 3.0, 2.125]), "tp3": entry + s * risk * rng.choice([4.0, 4.5, 3.375])}
    v = rng.random()
    if v < 0.5:
        lv["original_sl"] = lv["sl"]
    elif v < 0.65:
        lv["original_sl"] = lv["sl"]
        lv["sl"] = entry                  # moved to break-even
    elif v < 0.7:
        lv["original_sl"] = 0.0
    return lv


def outcome(r):
    k = rng.random()
    if k < 0.2:                           # exchange trade
        r["order_id"] = rng.choice([f"ox{rng.randint(1, 10**6)}", " ox9 "])
        r["result"] = rng.choice(["", "", "TP1", "TP2", "TP3", "SL", "SL", "BE", "MANUAL", "MANUAL", "TRAIL", "CLOSED", "SKIP", "tp1"])
        r["result_rr"] = rng.choice(RR_POOL + [round(rng.uniform(-1, 5), rng.choice([2, 3, 6]))])
        r["signal_msg_id"] = rng.choice([0, 0, 13])
        if r["result"] not in ("", "SKIP") and rng.random() < 0.6:
            r["closed_pnl_usd"] = rng.choice([round(rng.uniform(-40, 80), 2), 0.1, 0.2, -0.3])
        if rng.random() < 0.15:
            r["progress_stage"] = rng.choice(["TP1", "SL", "EXPIRED"])
    elif k < 0.27:                        # ghost / not delivered
        r["result"] = "SKIP"
        r["skip_reason"] = rng.choice(["ghost", "not_delivered", ""])
        r["signal_msg_id"] = rng.choice([0, 0, 22])
        r["order_id"] = rng.choice(["", "", "  "])
        if rng.random() < 0.3:
            r["progress_stage"] = rng.choice(["TP2", "SL"])
    elif k < 0.3:
        r["result"] = rng.choice(["ORPHAN", "orphan"])
    elif k < 0.37:                        # manual result in the bot UI
        r["signal_msg_id"] = 31
        r["result"] = rng.choice(["TP1", "TP2", "TP3", "SL", "BE", "SKIP", "MANUAL"])
        r["result_rr"] = {"TP1": 2.0, "TP2": 3.0, "TP3": 4.5, "SL": -1.0, "BE": 0.0, "SKIP": 0.0,
                          "MANUAL": rng.choice([0.6, -0.4, 0.0])}[r["result"]]
        if r["result"] == "SKIP":
            r["skip_reason"] = "manual"
            r["progress_stage"] = rng.choice(["", "TP2", "SL"])
    else:                                 # tracked signal
        r["signal_msg_id"] = rng.randint(1, 999)
        r["progress_stage"] = rng.choice(["", "", "ENTRY", "TP1", "TP1", "TP2", "TP3", "SL", "SL", "BE", "EXPIRED",
                                          "EXPIRED", "MISSED", "tp2"])
        if r["progress_stage"] == "EXPIRED":
            r["expire_rr"] = rng.choice([None, 0.125, -0.375, round(rng.uniform(-1, 2.5), 2), 1.005, rng.uniform(-1, 2)])
        if rng.random() < 0.12:
            r["result"] = "SKIP"
            r["skip_reason"] = "ghost"


def created_choice():
    return rng.choice([NOW - rng.uniform(0, 100 * 86400), NOW - rng.uniform(0, 8 * 86400), NOW - rng.uniform(0, 86400),
                       NOW - 7 * 86400, NOW - 30 * 86400, NOW - 90 * 86400, NOW - 86400, NOW - 72 * 3600,
                       float(int(NOW - rng.uniform(0, 30 * 86400)) // 3600 * 3600)])


def add(uid, base, created):
    global seq
    seq += 1
    r = {"trade_id": f"r{seq:04d}_{uid}", "user_id": uid, "symbol": base["symbol"], "direction": base["direction"],
         **base["levels"], "created_at": created, "strategy": base["strategy"], "timeframe": base["tf"],
         "quality": rng.choice([0, 1, 3, 5, 7, 10, None]), "trend_ctx": base["ctx"], "mtf_aligned": base["mtf"],
         "is_counter_trend": base["counter"], "breakout_type": rng.choice(["", "SMC", "pivot", "SCALP", None, "VOLUME"]),
         "result": "", "result_rr": 0, "order_id": "", "signal_msg_id": 0, "progress_stage": "",
         "skip_reason": "", "user_note": rng.choice(["", "", "нота", "<b>x</b>"])}
    outcome(r)
    trades.append(r)


def base_signal():
    d = rng.choice(["LONG", "SHORT", "LONG", "SHORT", "long"])
    return {"symbol": rng.choice(SYMS), "direction": d,
            "levels": levels(d.upper(), rng.choice([100.0, 2.5, 65000.0, 0.00123, 1.0])),
            "strategy": rng.choice(STRATS), "tf": rng.choice(TFS), "ctx": rng.choice(CTX),
            "mtf": rng.choice([0, 0, 1]), "counter": rng.choice([0, 0, 1])}


# shared signals (the same signal at several users, outcomes drawn per user)
while len(trades) < 260:
    b = base_signal()
    c = created_choice()
    for uid in rng.sample(UIDS, rng.randint(2, 6)):
        add(uid, b, c + rng.choice([0.0, 0.0, rng.uniform(0, 900)]))
# private signals, some with created_at ties
while len(trades) < 500:
    uid = rng.choice(UIDS)
    c = created_choice()
    for _ in range(rng.choice([1, 1, 1, 2, 3])):
        add(uid, base_signal(), c)
trades = trades[:500]
rng.shuffle(trades)

con = sqlite3.connect(DBP)
for uid, plan in USERS:
    con.execute("INSERT OR REPLACE INTO users (user_id, sub_plan) VALUES (?, ?)", (uid, plan))
COLS = sorted({k for r in trades for k in r})
for r in trades:
    con.execute(f"INSERT INTO trades ({', '.join(COLS)}) VALUES ({', '.join('?' * len(COLS))})", [r.get(c) for c in COLS])
con.commit()
con.close()

_time.time = lambda: NOW


async def safe(coro):
    try:
        return {"ok": await coro}
    except Exception as e:  # noqa: BLE001
        return {"raise": type(e).__name__}


def safe_sync(fn, *a):
    try:
        return {"ok": fn(*a)}
    except Exception as e:  # noqa: BLE001
        return {"raise": type(e).__name__}


async def collect():
    res = {"per_user": {}}
    for uid, _plan in USERS:
        u = {}
        for d in (30, 7, 90, 1):
            u[f"signal_stats_{d}"] = await ss.signal_stats(uid, d)
        u["rows_since"] = await ss.signal_rows_since(uid, NOW - 7 * 86400)
        u["dashboard_30"] = await dbs.db_dashboard_stats(uid, 30)
        u["dashboard_7"] = await dbs.db_dashboard_stats(uid, 7)
        u["auto"] = await dbs.db_get_auto_stats(uid)
        for p in (1, 7, 30):
            u[f"auto_{p}"] = await dbs.db_get_auto_stats_period(uid, p)
        u["user_stats"] = await safe(dbs.db_get_user_stats(uid))
        u["by_strategy"] = await safe(dbs.db_get_user_stats_by_strategy(uid))
        u["sl_count_24"] = await dbs.db_get_recent_sl_count(uid, 24)
        u["sl_count_720"] = await dbs.db_get_recent_sl_count(uid, 720)
        us = u["user_stats"].get("ok")
        u["ev_block"] = safe_sync(dbs.format_ev_block, us if us is not None else {})
        bs = u["by_strategy"].get("ok") or {}
        u["ev_short"] = {k: dbs.format_ev_short(v) for k, v in bs.items()}
        u["signals"] = {}
        for status in ("all", "open", "closed"):
            for strat in ("", "SMC"):
                u["signals"][f"{status}|{strat}|50"] = await miniapp_api._user_signals(uid, status, 50, strat)
        u["stats"] = {}
        for q in ({}, {"days": "7"}, {"days": "90"}, {"days": "365", "strategy": "levels"}, {"strategy": "VOLUME"},
                  {"tf": "1h"}, {"tf": "15M", "days": "60"}):
            async def _lu(_req, _uid=uid):
                return None, SimpleNamespace(user_id=_uid)
            miniapp_api._load_user = _lu
            resp = await miniapp_api.h_stats(SimpleNamespace(query=q))
            u["stats"][json.dumps(q, sort_keys=True)] = json.loads(resp.text)
        res["per_user"][str(uid)] = u
    for d in (7, 30, 1, 90):
        res[f"pro_overview_{d}"] = await ss.pro_overview(d)
    for d in (30, 7, 90):
        res[f"rating_{d}"] = await ss.strategy_rating(d, force=True)
    return res


out = {"now": NOW, "users": USERS, "trades": trades, "insert_cols": COLS}
out.update(LOOP.run_until_complete(collect()))
json.dump(out, open(OUT, "w"), ensure_ascii=False, default=float)
print("written", OUT, len(trades), "trades",
      {k: sum(1 for t in trades if (t.get("result") or "") == k) for k in ("", "SKIP", "ORPHAN", "TP1", "MANUAL")})
sys.stdout.flush()
os._exit(0)
