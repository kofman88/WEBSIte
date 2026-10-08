"""gen_reports_vectors.py — real outputs of the bot's daily_summary.py and weekly_digest.py
for backend/tests/engine/stats/reports.test.js.

Run with the bot's venv after gen_stats_vectors.py (it reads that fixture for the per-user
stats the bot computed on the seeded DB):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python gen_reports_vectors.py STATS.json OUT.json
(afterwards: rm -f <bot>/signal_registry.json)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from datetime import datetime as _dt, timezone
from types import SimpleNamespace

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
os.chdir(BOT)
sys.path.insert(0, BOT)
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
os.environ.pop("MINIAPP_URL", None)

import daily_summary as dsm  # noqa: E402
import weekly_digest as wd  # noqa: E402

STATS = json.load(open(sys.argv[1]))
OUT = sys.argv[2]
out: dict = {}

LOG_LINES: list = []


class _Cap(logging.Handler):
    def emit(self, record):
        if record.levelno >= logging.INFO:
            LOG_LINES.append(record.getMessage())


for name in ("CHM.DailySummary", "CHM.WeeklyDigest"):
    logging.getLogger(name).addHandler(_Cap())
    logging.getLogger(name).setLevel(logging.INFO)

FIXED = [1_766_000_000.0]      # mutable "now" for the patched datetime.now


class FixedDT(_dt):
    @classmethod
    def now(cls, tz=None):
        return _dt.fromtimestamp(FIXED[0], tz or timezone.utc)


dsm.datetime = FixedDT

# ── daily summary texts ─────────────────────────────────────────────────────
NOWS = [1_766_000_000.0, 1_767_225_599.0, 1_770_000_000.0, 1_772_150_400.0, 1_780_000_000.0, 1_757_000_000.0,
        1_762_000_000.0, 1_741_000_000.0, 1_745_000_000.0, 1_748_000_000.0, 1_751_000_000.0, 1_754_000_000.0]
base24 = {"closed": 4, "tp1": 2, "tp2": 1, "tp3": 0, "sl": 1, "be": 0, "total_rr": 2.5, "winrate_pct": 75,
          "best_symbol": "BTC-USDT-SWAP", "worst_symbol": "PEPE-USDT"}
base7 = {"closed": 9, "total_rr": -1.255, "winrate_pct": 44}
cases = [
    ("zero", {**base24, "closed": 0}, base7),
    ("great", base24, base7),
    ("positive small", {**base24, "total_rr": 0.4}, base7),
    ("calm", {**base24, "total_rr": -0.5}, base7),
    ("hard", {**base24, "total_rr": -1.0}, base7),
    ("hard2", {**base24, "total_rr": -3.333}, {**base7, "closed": 2}),
    ("be shown", {**base24, "be": 2}, base7),
    ("best only", {**base24, "worst_symbol": ""}, base7),
    ("worst == best", {**base24, "worst_symbol": "BTC-USDT-SWAP"}, base7),
    ("no best", {**base24, "best_symbol": "", "worst_symbol": "ETH-USDT-SWAP"}, base7),
    ("7d exactly 3", base24, {**base7, "closed": 3, "total_rr": 0.0}),
    ("rr exactly 1", {**base24, "total_rr": 1.0}, base7),
    ("rr exactly 0", {**base24, "total_rr": 0.0}, base7),
    ("rounding .125", {**base24, "total_rr": 0.125, "winrate_pct": 62.5}, {**base7, "total_rr": 2.675, "winrate_pct": 50.5}),
    ("none values", {**base24, "tp1": None, "be": None, "total_rr": None, "winrate_pct": None}, {}),
    ("strings", {**base24, "closed": "3", "tp1": "1", "total_rr": "1.5"}, {**base7, "closed": "5"}),
]
out["daily_texts"] = []
for i, (name, s24, s7) in enumerate(cases):
    for lang in ("ru", "en", "de"):
        FIXED[0] = NOWS[i % len(NOWS)]
        out["daily_texts"].append({"name": name, "lang": lang, "now": FIXED[0], "s24": s24, "s7": s7,
                                   "text": dsm._format_summary(s24, s7, lang=lang)})
out["daily_next"] = []
for t in (1_766_000_000.0, 1_766_015_700.0, 1_766_015_699.0, 1_766_015_701.0, 1_766_016_000.0, 1_765_929_600.0):
    FIXED[0] = t
    out["daily_next"].append({"now": t, "s": dsm._seconds_until_next_summary()})
out["daily_per_user"] = {}
FIXED[0] = STATS["now"]
for uid, p in STATS["per_user"].items():
    out["daily_per_user"][uid] = {lang: dsm._format_summary(p["auto_1"], p["auto_7"], lang=lang) for lang in ("ru", "en")}

# ── weekly digest texts ─────────────────────────────────────────────────────
wnow = _dt.fromtimestamp(STATS["now"], timezone.utc)
out["weekly_per_user"] = {}
for uid, p in STATS["per_user"].items():
    d = {}
    for lang in ("ru", "en", "xx"):
        for plan in ("pro", "free", "", "FREE"):
            for pro_key in ("pro_overview_7", "none", "zero"):
                pro = STATS.get(pro_key) if pro_key == "pro_overview_7" else (None if pro_key == "none" else {"pro_users": 0})
                d[f"{lang}|{plan}|{pro_key}"] = wd.format_digest(p["signal_stats_7"], lang, plan, pro, wnow)
    out["weekly_per_user"][uid] = d
extra = [
    {"signals": 0},
    {"signals": 3, "wins": 0, "losses": 0, "trades": 0, "open": 3, "per_strategy": {}},
    {"signals": 5, "wins": 2, "losses": 1, "be": 1, "expired": 1, "trades": 4, "total_rr": -0.04, "win_rate": 50.5,
     "best_rr": 2.0, "best_symbol": "SOL", "best_direction": "LONG", "open": 0,
     "per_strategy": {"LEVELS": {"signals": 2, "total_rr": 1.25, "trades": 2}, "SMC": {"signals": 0}, "VOLUME": {"signals": 3, "total_rr": -0.05, "trades": 1}}},
    {"signals": 2, "wins": 1, "losses": 1, "trades": 2, "total_rr": 0.0, "win_rate": 62.5, "best_rr": None, "best_symbol": "X"},
    {"signals": 2, "wins": 1, "losses": 1, "trades": 2, "total_rr": 0.05, "win_rate": 2.5, "best_rr": 0.04, "best_symbol": ""},
]
pros = [None, {"pro_users": 3, "avg_signals": 4.5, "unique_rr": 12.349, "unique_signals": 9}, {"pro_users": 1, "avg_signals": 0.0, "unique_rr": -0.04, "unique_signals": 0}]
out["weekly_extra"] = []
for s in extra:
    for pro in pros:
        for lang in ("ru", "en"):
            for nowts in (1_766_000_000.0, 1_767_225_600.0, 1_772_323_200.0):
                n = _dt.fromtimestamp(nowts, timezone.utc)
                out["weekly_extra"].append({"stats": s, "pro": pro, "lang": lang, "plan": "free", "now": nowts,
                                            "text": wd.format_digest(s, lang, "free", pro, n)})
out["weekly_r"] = {repr(x): wd._r(x) for x in (0.0, -0.0, 0.04, -0.04, 0.05, -0.05, 1.25, -1.25, 0.15, 2.675, 10.0, -0.01)}
out["weekly_next"] = []
for ts in (1_766_000_000.0, 1_765_789_500.0, 1_765_789_499.0, 1_765_789_501.0, 1_765_000_000.0, 1_765_800_000.0):
    n = _dt.fromtimestamp(ts, timezone.utc)
    out["weekly_next"].append({"now": ts, "s": wd.seconds_until_next(n), "week": wd.week_key(n)})
out["week_keys"] = {str(ts): wd.week_key(_dt.fromtimestamp(ts, timezone.utc)) for ts in
                    (1_735_603_200.0, 1_735_689_600.0, 1_767_139_200.0, 1_767_225_600.0, 1_767_830_400.0, 1_704_067_200.0, 1_609_459_200.0)}
out["weekly_consts"] = {"WEEKDAY": wd.WEEKDAY, "HOUR_UTC": wd.HOUR_UTC, "MINUTE_UTC": wd.MINUTE_UTC, "KV": wd.KV_LAST_WEEK,
                        "PAUSE": wd.SEND_PAUSE_S, "T": wd._T}

# ── run loops with fakes (users, DB functions, send) ────────────────────────
import database  # noqa: E402
import telegram_safe  # noqa: E402
import db.signal_stats as ss  # noqa: E402
import challenge as chal  # noqa: E402

USERS = [{"user_id": 101, "auto_trade": 1}, {"user_id": 102, "auto_trade": 0}, {"user_id": 103, "auto_trade": 1},
         {"user_id": 104, "auto_trade": 1}, {"user_id": 999, "auto_trade": 1}, {"user_id": 105, "auto_trade": 1},
         {"user_id": 106, "auto_trade": 0}, {"user_id": 109, "auto_trade": 1}]
UM = {101: SimpleNamespace(user_id=101, lang="ru", sub_plan="pro"), 102: SimpleNamespace(user_id=102, lang="en", sub_plan="pro"),
      103: SimpleNamespace(user_id=103, lang="ru", sub_plan="free"), 104: SimpleNamespace(user_id=104, lang="en", sub_plan="pro"),
      105: SimpleNamespace(user_id=105, lang="ru", sub_plan="free"), 106: SimpleNamespace(user_id=106, lang="ru", sub_plan="pro"),
      109: SimpleNamespace(user_id=109, lang="en", sub_plan="pro")}
SENT: list = []
FAIL_SEND = {104}


async def fake_send(bot, uid, text, **kw):
    SENT.append({"uid": uid, "text": text})
    return uid not in FAIL_SEND


async def fake_all_users():
    return [dict(u) for u in USERS]


AUTO = {101: (base24, base7), 103: ({**base24, "total_rr": -2.0, "be": 1}, {**base7, "closed": 1}),
        104: (base24, base7), 105: ({**base24, "closed": 0}, base7), 109: ({**base24, "total_rr": 0.5, "worst_symbol": ""}, {})}
out["daily_auto"] = {str(k): {"1": v[0], "7": v[1]} for k, v in AUTO.items()}


async def fake_auto_period(uid, days):
    v = AUTO.get(uid)
    if v is None:
        return {}
    return dict(v[0] if days == 1 else v[1])


async def fake_signal_stats(uid, days=7):
    p = STATS["per_user"].get(str(uid))
    return p["signal_stats_7"] if p else {"signals": 0}


async def fake_pro(days=7):
    return STATS["pro_overview_7"]


class _Ch:
    status = chal.STATUS_ACTIVE
    started_at = 0.0


async def fake_load(uid):
    return _Ch() if uid == 101 else None


async def fake_rows_since(uid, since):
    return []

telegram_safe.safe_send_message = fake_send
database.db_get_all_users = fake_all_users
database.db_get_auto_stats_period = fake_auto_period
ss.signal_stats = fake_signal_stats
ss.pro_overview = fake_pro
ss.signal_rows_since = fake_rows_since
chal.load = fake_load
chal.progress = lambda ch, rows: {"r": 1.5}
chal.progress_text = lambda ch, pr, lang, short=False: f"🎯 Челлендж ({lang}): +{pr['r']}R"


async def _um_get(uid):
    return UM.get(uid)

um = SimpleNamespace(get=_um_get)


async def daily_iteration():
    # body of daily_summary_loop for one tick (the loop itself sleeps until 23:55)
    all_users = await database.db_get_all_users()
    sent = skipped = 0
    for user_row in all_users:
        if not user_row.get("auto_trade"):
            skipped += 1
            continue
        user = await um.get(int(user_row["user_id"]))
        if user is None:
            skipped += 1
            continue
        ok = await dsm._build_and_send_for_user(None, user)
        if ok:
            sent += 1
        else:
            skipped += 1
    dsm.log.info("[DAILY-SUMMARY] iteration: sent=%d skipped=%d total=%d", sent, skipped, len(all_users))
    return sent, skipped

FIXED[0] = STATS["now"]
SENT.clear()
LOG_LINES.clear()
d_res = asyncio.run(daily_iteration())
out["daily_run"] = {"now": STATS["now"], "users": USERS, "um": {str(k): vars(v) for k, v in UM.items()},
                    "result": list(d_res), "sent": list(SENT), "log": list(LOG_LINES), "fail_send": sorted(FAIL_SEND)}

SENT.clear()
LOG_LINES.clear()
w_now = _dt.fromtimestamp(STATS["now"], timezone.utc)
wd.SEND_PAUSE_S = 0.0
w_res = asyncio.run(wd.run_once(None, um, w_now))
out["weekly_run"] = {"now": STATS["now"], "result": list(w_res), "sent": list(SENT), "log": list(LOG_LINES)}

json.dump(out, open(OUT, "w"), ensure_ascii=False, indent=0, default=float)
print("written", OUT, {k: len(v) if hasattr(v, "__len__") else v for k, v in out.items()})
sys.stdout.flush()
os._exit(0)
