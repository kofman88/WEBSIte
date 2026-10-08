"""gen_reports_rand.py — the bot's REAL daily_summary_loop and weekly_digest_loop (one
iteration each, the weekly one twice for the ISO-week kv dedup) over a bot-schema SQLite
seeded with random exchange trades and tracked signals of 10 random users, for
backend/tests/engine/stats/reportsRand.test.js. time.time and the modules' datetime.now are
pinned; telegram_safe.safe_send_message is captured (one user's send returns False, one
raises); asyncio.sleep is short-circuited and the second scheduler sleep ends the loop.

  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python gen_reports_rand.py [OUT]
  ([OUT] defaults to the shipped fixture; a relative path resolves against the caller's cwd)
  (afterwards: rm -f <bot>/signal_registry.json)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import sqlite3
import sys
import tempfile
import time as _time
from datetime import datetime as _dt, timezone
from types import SimpleNamespace

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
_CWD = os.getcwd()   # caller cwd: relative paths below resolve against it, not against the bot dir
os.chdir(BOT)
sys.path.insert(0, BOT)
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
os.environ.pop("MINIAPP_URL", None)

import daily_summary as dsm  # noqa: E402
import database  # noqa: E402
import telegram_safe  # noqa: E402
import weekly_digest as wd  # noqa: E402

OUT = os.path.join(_CWD, sys.argv[1]) if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "reports_rand.json")
rng = random.Random(1010)

NOW_D = 1_769_903_700.0          # 2026-01-31 23:55:00 UTC (Saturday)
NOW_W = 1_770_627_900.0          # 2026-02-09 09:05:00 UTC (Monday)
NOW = [NOW_D]

tmp = tempfile.mkdtemp(prefix="m10a_reports_rand_")
DBP = os.path.join(tmp, "bot.db")
LOOP = asyncio.new_event_loop()
asyncio.set_event_loop(LOOP)
LOOP.run_until_complete(database.init_db(DBP))

UIDS = rng.sample(range(400, 999), 10)
USERS = []
for uid in UIDS:
    USERS.append({"user_id": uid, "lang": rng.choice(["ru", "en", None, "ru"]),
                  "sub_plan": rng.choice(["pro", "free", "free", "trial", ""]),
                  "auto_trade": rng.choice([1, 1, 1, 0])})
USERS[0]["sub_plan"], USERS[1]["sub_plan"] = "pro", "free"
USERS[0]["auto_trade"] = USERS[1]["auto_trade"] = 1
SEND_FALSE = USERS[2]["user_id"]
SEND_RAISE = USERS[3]["user_id"]
SYMS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT", "PEPE-USDT-SWAP", "DOGE-USDT-SWAP"]
trades = []
seq = 0
for u in USERS:
    for _ in range(rng.randint(0, 28)):
        seq += 1
        d = rng.choice(["LONG", "SHORT"])
        s = 1 if d == "LONG" else -1
        e = rng.choice([100.0, 2.5, 65000.0])
        risk = e * rng.uniform(0.004, 0.02)
        anchor = rng.choice([NOW_D, NOW_W])
        r = {"trade_id": f"q{seq:04d}", "user_id": u["user_id"], "symbol": rng.choice(SYMS), "direction": d,
             "entry": e, "sl": e - s * risk, "original_sl": e - s * risk, "tp1": e + s * risk * 1.5,
             "tp2": e + s * risk * 2.5, "tp3": e + s * risk * 4.0,
             "created_at": anchor - rng.choice([rng.uniform(0, 86400), rng.uniform(0, 8 * 86400), 86400.0, 7 * 86400.0]),
             "strategy": rng.choice(["LEVELS", "SMC", "VOLUME", "smc", ""]), "timeframe": "1h",
             "result": "", "result_rr": 0.0, "order_id": "", "signal_msg_id": 0, "progress_stage": ""}
        if rng.random() < 0.55:                     # exchange trade (daily summary)
            r["order_id"] = f"o{seq}"
            r["result"] = rng.choice(["", "TP1", "TP2", "TP3", "SL", "SL", "BE", "MANUAL", "CLOSED", "SKIP", "TRAIL"])
            r["result_rr"] = {"": 0.0, "TP1": 1.5, "TP2": 2.5, "TP3": 4.0, "SL": -1.0, "BE": 0.0, "SKIP": 0.0,
                              "MANUAL": rng.choice([0.625, -0.375, 0.0]), "CLOSED": 0.125, "TRAIL": 1.875}[r["result"]]
        else:                                       # tracked signal (weekly digest)
            r["signal_msg_id"] = rng.randint(1, 99)
            r["progress_stage"] = rng.choice(["", "ENTRY", "TP1", "TP2", "TP3", "SL", "BE", "EXPIRED", "MISSED"])
            if r["progress_stage"] == "EXPIRED":
                r["expire_rr"] = rng.choice([None, 0.25, -0.625])
        trades.append(r)
rng.shuffle(trades)

con = sqlite3.connect(DBP)
for u in USERS:
    con.execute("INSERT OR REPLACE INTO users (user_id, sub_plan, lang, auto_trade) VALUES (?, ?, ?, ?)",
                (u["user_id"], u["sub_plan"], u["lang"] or "ru", u["auto_trade"]))
COLS = sorted({k for r in trades for k in r})
for r in trades:
    con.execute(f"INSERT INTO trades ({', '.join(COLS)}) VALUES ({', '.join('?' * len(COLS))})", [r.get(c) for c in COLS])
con.commit()
con.close()

_time.time = lambda: NOW[0]


class FixedDT(_dt):
    @classmethod
    def now(cls, tz=None):
        return _dt.fromtimestamp(NOW[0], tz or timezone.utc)


dsm.datetime = FixedDT
wd.datetime = FixedDT

SENT: list = []


async def fake_send(bot, uid, text, **kw):
    SENT.append({"uid": uid, "text": text, "kb": kw.get("reply_markup") is not None})
    if uid == SEND_RAISE:
        raise RuntimeError("network down")
    return uid != SEND_FALSE


telegram_safe.safe_send_message = fake_send


async def all_users():
    return [{"user_id": u["user_id"], "auto_trade": u["auto_trade"]} for u in USERS]


database.db_get_all_users = all_users


class UM:
    async def get(self, uid):
        for u in USERS:
            if u["user_id"] == uid:
                return SimpleNamespace(user_id=uid, lang=u["lang"], sub_plan=u["sub_plan"])
        return None


class _Stop(Exception):
    pass


class FakeAsyncio:
    """asyncio stand-in for the loop modules: the first scheduler sleep returns, the second one
    ends the loop (CancelledError), the 0.5 s pauses return immediately."""
    CancelledError = asyncio.CancelledError

    def __init__(self):
        self.sleeps = []
        self.big = 0

    async def sleep(self, s):
        self.sleeps.append(s)
        if s > 1.0:
            self.big += 1
            if self.big > 1:
                raise asyncio.CancelledError()


LOG_LINES: list = []


class _Cap(logging.Handler):
    def emit(self, record):
        if record.levelno >= logging.INFO:
            LOG_LINES.append(record.getMessage())


for name in ("CHM.DailySummary", "CHM.WeeklyDigest"):
    logging.getLogger(name).addHandler(_Cap())
    logging.getLogger(name).setLevel(logging.INFO)

out = {"now_daily": NOW_D, "now_weekly": NOW_W, "users": USERS, "send_false": SEND_FALSE, "send_raise": SEND_RAISE,
       "trades": trades, "insert_cols": COLS}

# daily
NOW[0] = NOW_D
fa = FakeAsyncio()
dsm.asyncio = fa
LOG_LINES.clear()
SENT.clear()
LOOP.run_until_complete(dsm.daily_summary_loop(None, UM()))
out["daily"] = {"sent": list(SENT), "logs": list(LOG_LINES), "sleeps": fa.sleeps}

# weekly, twice in the same ISO week (second run is deduplicated by the kv key)
NOW[0] = NOW_W
out["weekly"] = []
for k in range(2):
    fa = FakeAsyncio()
    wd.asyncio = fa
    LOG_LINES.clear()
    SENT.clear()
    LOOP.run_until_complete(wd.weekly_digest_loop(None, UM()))
    out["weekly"].append({"sent": list(SENT), "logs": list(LOG_LINES), "sleeps": fa.sleeps,
                          "kv": LOOP.run_until_complete(database.db_kv_get(wd.KV_LAST_WEEK))})
json.dump(out, open(OUT, "w"), ensure_ascii=False)
print("daily sent", len(out["daily"]["sent"]), "weekly sent", [len(w["sent"]) for w in out["weekly"]])
print("\n".join(out["daily"]["logs"] + out["weekly"][0]["logs"] + out["weekly"][1]["logs"]))
sys.stdout.flush()
os._exit(0)
