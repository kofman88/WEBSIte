"""gen_challenge_vectors.py — real outputs of the bot's challenge.py, handlers/challenge.py,
entry_advisor.py and the Mini App challenge handlers (miniapp_api.h_challenge_*) for the
JS parity tests in backend/tests/challenge/*.test.js.

Run with the bot's venv (the script chdirs into the bot checkout itself):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python gen_challenge_vectors.py OUT.json
afterwards: rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json

time.time() is pinned (FAKE[0]) so every function that reads the wall clock (notify_once,
_send_card, signal_stats, missed_stats, _rate_ok …) sees the instant the JS side passes as
its clock. Rows are inserted into a fresh bot schema (database.init_db) in a temp dir; the
JS side inserts the same rows into signal_trades.
"""
from __future__ import annotations

import asyncio
import importlib
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

import faulthandler  # noqa: E402
faulthandler.dump_traceback_later(240, exit=True)

import challenge as C  # noqa: E402
import database  # noqa: E402
import entry_advisor as EA  # noqa: E402
import handlers.challenge as H  # noqa: E402
import miniapp_api as M  # noqa: E402
from aiohttp import web  # noqa: E402
from db import signal_stats as SS  # noqa: E402
from user_manager import UserSettings  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else "challenge_vectors.json"
rng = random.Random(20261017)
T0 = 1_767_225_600.0                      # 2026-01-01 00:00:00 UTC (Thursday)
FAKE = [T0]
_time.time = lambda: FAKE[0]              # every bot module calls time.time()
out: dict = {"t0": T0, "daily_hour_utc": C.DAILY_HOUR_UTC, "loop_interval_s": C.LOOP_INTERVAL_S}

def _hook(t, v, tb):
    import traceback
    traceback.print_exception(t, v, tb)
    sys.stderr.flush()
    os._exit(1)


sys.excepthook = _hook
LOOP = asyncio.new_event_loop()
asyncio.set_event_loop(LOOP)
run = LOOP.run_until_complete


def err(e):
    return {"ok": False, "etype": type(e).__name__, "msg": str(e)}


# ════════════════════════════════════════════════════════════════════════
# 1. build(): validation table
# ════════════════════════════════════════════════════════════════════════
BASE = {"deposit": 1000, "goal_kind": "pct", "goal_value": 25, "term": "1m", "risk_pct": 1, "leverage": 5,
        "max_trades_day": 3, "daily_loss_pct": 3, "topup_monthly": 0, "strategies": ["LEVELS"], "mode": "signals"}
VARIANTS = {
    "deposit": [9.99, 9.999, 10, 10.0, 10.001, 10_000_000, 10_000_000.0, 10_000_000.01, 0, "", None, "1000",
                "abc", True, False, [], [1], {}, {"a": 1}, "1e3", " 1000 ", "1_000", "inf", "-inf", "nan", -5,
                "0x10", "1,5", "it's", 'say "hi"', "\t7", "1234.5678", 1234.5678, 1234.565, 1234.575, 2.675, "١٠٠٠", "１２３４.５"],
    "goal_kind": ["", None, "usd", "pct", "USD", "Pct", 5, ["pct"], {"pct": 1}, True, 0],
    "goal_value": [0.99, 1, 1.0, 1000, 1000.0, 1000.01, 0, None, "", "25", "x", [], [25], 12.345, 12.355,
                   2.675, 1.005, 999.995],
    "term": ["2w", "1m", "3m", "none", "", None, "1w", "NONE", 0, 5, ["1m"]],
    "risk_pct": [0.09, 0.099, 0.1, 0.1001, 10, 10.0, 10.01, 0, None, "", "1.5", "1,5", True, 1.005, 0.125, 2.345],
    "leverage": [0, None, 1, 125, 126, "5", "5.5", 5.9, 1.9999, True, False, "abc", [], [5], {}, -1, "  7 ",
                 "7_0", "+3", 125.9, 0.5, "５", "𝟏𝟎"],
    "max_trades_day": [-1, 0, 100, 101, "3", 3.7, None, "", "x", True, [3], -0.5],
    "daily_loss_pct": [-0.01, 0, 0.0, 50, 50.0, 50.01, None, "", "3", "x", 2.345, 0.005, True],
    "topup_monthly": [-1, 0, 10_000_000, 10_000_000.01, None, "", "100", 99.995, "y", [1]],
    "strategies": [None, [], ["X"], ["LEVELS"], ["SMC", "LEVELS"], ["LEVELS", "LEVELS"], "LEVELS", "SMC",
                   {"SMC": 1, "LEVELS": 0}, {"X": 1}, 5, True, 1.5, [["LEVELS"]], [None, "VOLUME"],
                   ["levels"], ["VOLUME", "SMC", "LEVELS", "SMC"], "", {}, 0, False],
    "mode": [None, "", "auto", "signals", "AUTO", 1, ["auto"], True, 0],
}
cases = [dict(BASE), {}]
for k, vals in VARIANTS.items():
    for v in vals:
        d = dict(BASE)
        d[k] = v
        cases.append(d)
    d = dict(BASE)
    d.pop(k)
    cases.append(d)
# usd goal boundaries relative to the deposit
for dep, gv in ((1000, 1000), (1000, 1000.01), (1000, 100_000), (1000, 100_000.01), (10, 1000), (10, 1000.5),
                (1234.567, 1234.567), (1234.567, 1234.57), (500, 0), (500, "2500"), (500, "x")):
    d = dict(BASE)
    d.update(deposit=dep, goal_kind="usd", goal_value=gv)
    cases.append(d)
# error ordering: several bad fields at once → the first one in the bot's order wins
cases.append({"deposit": 5, "goal_kind": "x", "leverage": 0})
cases.append({"deposit": 50, "goal_kind": "x", "leverage": 0})
cases.append({"deposit": 50, "goal_value": 5, "term": "zz", "risk_pct": 0})
cases.append({"deposit": 50, "goal_value": 5, "risk_pct": 1, "leverage": [1], "max_trades_day": "q"})
cases.append({"deposit": 50, "goal_value": 5, "risk_pct": 1, "leverage": 3, "max_trades_day": "q", "strategies": 7})
cases.append({"deposit": 50, "goal_value": 5, "risk_pct": 1, "leverage": 3, "strategies": 7, "mode": "x"})
cases.append({"deposit": 50, "goal_value": 5, "risk_pct": 1, "leverage": 3, "strategies": ["SMC"], "mode": "x"})
validation = []
NOW_BUILD = T0 + 12345.678
for a in cases:
    try:
        ch = C.build(77, a, now=NOW_BUILD)
        validation.append({"answers": a, "ok": True, "json": ch.to_json(),
                           "bad_ru": None})
    except Exception as e:  # noqa: BLE001
        r = err(e)
        r["answers"] = a
        r["bad_ru"] = H._L["ru"]["bad"] + str(e)
        r["bad_en"] = H._L["en"]["bad"] + str(e)
        validation.append(r)
out["validation"] = {"now": NOW_BUILD, "uid": 77, "cases": validation}

# ════════════════════════════════════════════════════════════════════════
# 2. plan(): 30 random answer sets × 5 stats profiles (+ edge sets)
# ════════════════════════════════════════════════════════════════════════
STATS_PROFILES = [None, {"trades": 9, "total_rr": 5.0}, {"trades": 25, "total_rr": 18.37},
                  {"trades": 30, "total_rr": -4.5}, {"trades": 12, "total_rr": 0.0}]


def rand_answers():
    kind = rng.choice(["pct", "pct", "usd"])
    dep = rng.choice([10, 100, 500, 1000, 2500, 3333.33, 10_000, 123_456.78, rng.uniform(10, 50_000)])
    gv = rng.choice([1, 10, 25, 50, 100, 300, rng.uniform(1, 1000)]) if kind == "pct" \
        else dep * rng.choice([1.01, 1.1, 1.5, 2, 10, 100, rng.uniform(1.001, 100)])
    return {"deposit": dep, "goal_kind": kind, "goal_value": gv, "term": rng.choice(list(C.TERMS_DAYS)),
            "risk_pct": rng.choice([0.1, 0.25, 0.5, 1, 1.5, 2, 2.99, 3, 5, 10, rng.uniform(0.1, 10)]),
            "leverage": rng.choice([1, 2, 3, 5, 10, 20, 33, 34, 50, 100, 125, rng.randint(1, 125)]),
            "max_trades_day": rng.choice([0, 1, 2, 3, 5, 10, 100]),
            "daily_loss_pct": rng.choice([0, 0.5, 1, 2, 3, 5, 50, rng.uniform(0, 50)]),
            "topup_monthly": rng.choice([0, 0, 100, 1000, 12_345.67]),
            "strategies": rng.sample(["LEVELS", "SMC", "VOLUME"], rng.randint(1, 3)),
            "mode": rng.choice(["signals", "auto"])}


plan_sets = [rand_answers() for _ in range(30)]
plan_sets += [
    dict(BASE, risk_pct=3, leverage=33, daily_loss_pct=2),
    dict(BASE, risk_pct=10, leverage=1, daily_loss_pct=50),
    dict(BASE, risk_pct=0.1, leverage=125, daily_loss_pct=0.05),
    dict(BASE, deposit=10, goal_value=1, risk_pct=0.1),
    dict(BASE, deposit=10_000_000, goal_kind="usd", goal_value=1_000_000_000, risk_pct=0.1, term="none"),
    dict(BASE, deposit=1000, goal_value=1000, risk_pct=10, term="2w", topup_monthly=250),
]
plans = []
for a in plan_sets:
    started = T0 + rng.uniform(0, 5 * 86400)
    ch = C.build(78, a, now=started)
    offsets = [0.0, rng.uniform(0, 10 * 86400), rng.uniform(10 * 86400, 100 * 86400)]
    for prof in STATS_PROFILES:
        for off in offsets:
            now = started + off
            pl = C.plan(ch, prof, now=now)
            plans.append({"answers": a, "started": started, "now": now, "stats": prof, "plan": pl,
                          "json": ch.to_json(), "text_ru": C.plan_text(ch, pl, "ru"), "text_en": C.plan_text(ch, pl, "en")})
out["plan"] = plans

# ════════════════════════════════════════════════════════════════════════
# 3. progress() on seeded rows (pure)
# ════════════════════════════════════════════════════════════════════════
SYMS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "PEPE-USDT-SWAP", "DOGE-USDT"]
ROW_KEYS = ("result", "result_rr", "progress_stage", "entry", "sl", "original_sl", "tp1", "tp2", "tp3",
            "created_at", "strategy", "order_id", "signal_msg_id", "symbol", "direction", "expire_rr")


def mk_row(created, kind=None):
    d = rng.choice(["LONG", "SHORT"])
    s = 1 if d == "LONG" else -1
    e = rng.choice([100.0, 2.5, 65000.0, 0.01234])
    risk = e * rng.uniform(0.004, 0.02)
    r = {"result": "", "result_rr": 0.0, "progress_stage": "", "entry": e, "sl": e - s * risk,
         "original_sl": rng.choice([e - s * risk, None]), "tp1": e + s * risk * rng.choice([1.0, 1.5, 2.0]),
         "tp2": e + s * risk * rng.choice([2.5, 3.0]), "tp3": e + s * risk * rng.choice([4.0, 4.5]),
         "created_at": created, "strategy": rng.choice(["LEVELS", "SMC", "VOLUME", "", "smc"]), "order_id": "",
         "signal_msg_id": rng.randint(1, 999), "symbol": rng.choice(SYMS), "direction": d, "expire_rr": None}
    k = kind or rng.choice(["stage", "stage", "stage", "exchange", "skip", "manual"])
    if k == "stage":
        r["progress_stage"] = rng.choice(["", "", "ENTRY", "TP1", "TP2", "TP3", "SL", "SL", "BE", "EXPIRED", "MISSED"])
        if r["progress_stage"] == "EXPIRED":
            r["expire_rr"] = rng.choice([None, round(rng.uniform(-1, 2.5), 3)])
    elif k == "exchange":
        r["order_id"] = f"ox{rng.randint(1, 10**6)}"
        r["result"] = rng.choice(["", "TP1", "TP3", "SL", "BE", "MANUAL", "TRAIL", "CLOSED"])
        r["result_rr"] = {"": 0.0, "TP1": 1.5, "TP3": 4.4, "SL": -1.0, "BE": 0.0, "MANUAL": rng.choice([0.6, -0.4]),
                          "TRAIL": 1.9, "CLOSED": 0.33}[r["result"]]
    elif k == "skip":
        r["result"] = "SKIP"
        r["signal_msg_id"] = rng.choice([7, 0])
        r["order_id"] = rng.choice(["", "o1"]) if r["signal_msg_id"] == 0 else ""
    elif k == "manual":
        r["result"] = rng.choice(["TP2", "SL", "BE"])
        r["result_rr"] = {"TP2": 3.0, "SL": -1.0, "BE": 0.0}[r["result"]]
    elif k == "sl":
        r["progress_stage"] = "SL"
    elif k == "open":
        r["progress_stage"] = ""
    elif k == "tp3":
        r["progress_stage"] = "TP3"
    return r


progress_cases = []
for i in range(40):
    a = rand_answers() if i < 30 else dict(BASE, max_trades_day=rng.choice([1, 2, 3]), daily_loss_pct=rng.choice([1, 2]),
                                           risk_pct=1, term=rng.choice(["2w", "none"]))
    started = T0 + rng.uniform(0, 3 * 86400)
    ch = C.build(79, a, now=started)
    if rng.random() < 0.3:
        for _ in range(rng.randint(1, 3)):
            ch.topups.append({"ts": started + rng.uniform(0, 86400), "amount": round(rng.uniform(1, 5000), 2)})
    if rng.random() < 0.1:
        ch.status = rng.choice([C.STATUS_DONE, C.STATUS_CANCELLED])
    now = started + rng.choice([rng.uniform(0, 3600), rng.uniform(0, 5 * 86400), rng.uniform(5 * 86400, 120 * 86400)])
    midnight = C._day_start(now)
    rows = [mk_row(rng.uniform(started, now)) for _ in range(rng.randint(0, 25))]
    # today's rows (blocks)
    kinds = rng.choice([[], ["open"], ["sl", "sl"], ["sl", "sl", "sl"], ["open", "open", "open"], ["tp3", "sl"]])
    for kd in kinds:
        rows.append(mk_row(rng.uniform(max(midnight, started), now), kd))
    rng.shuffle(rows)
    pr = C.progress(ch, rows, now=now)
    progress_cases.append({"json": ch.to_json(), "rows": rows, "now": now, "progress": pr,
                           "ru": C.progress_text(ch, pr, "ru"), "en": C.progress_text(ch, pr, "en"),
                           "ru_short": C.progress_text(ch, pr, "ru", short=True),
                           "en_short": C.progress_text(ch, pr, "en", short=True),
                           "block_ru": C.block_text(pr["block_reason"], "ru") if pr["blocked"] else None,
                           "block_en": C.block_text(pr["block_reason"], "en") if pr["blocked"] else None})
# goal reached / negative / exact boundary cases
for rr_rows, a in (([("tp3", None)] * 6, dict(BASE, goal_value=10, risk_pct=2, term="2w")),
                   ([("sl", None)] * 4, dict(BASE, term="3m")),
                   ([], dict(BASE, deposit=10, goal_value=1, risk_pct=0.1))):
    started = T0 + 3600
    ch = C.build(80, a, now=started)
    now = started + 2 * 86400 + 7200
    rows = []
    for kd, _ in rr_rows:
        r = mk_row(rng.uniform(started, now), kd)
        r.update(entry=100.0, sl=98.0, original_sl=98.0, tp1=102.0, tp2=104.0, tp3=105.0, direction="LONG")
        rows.append(r)
    pr = C.progress(ch, rows, now=now)
    progress_cases.append({"json": ch.to_json(), "rows": rows, "now": now, "progress": pr,
                           "ru": C.progress_text(ch, pr, "ru"), "en": C.progress_text(ch, pr, "en"),
                           "ru_short": C.progress_text(ch, pr, "ru", short=True),
                           "en_short": C.progress_text(ch, pr, "en", short=True),
                           "block_ru": None, "block_en": None})
out["progress"] = progress_cases

# ════════════════════════════════════════════════════════════════════════
# 4. discipline table, day helpers, text helpers
# ════════════════════════════════════════════════════════════════════════
disc = []
for status in (C.STATUS_ACTIVE, C.STATUS_DONE, C.STATUS_EXPIRED, C.STATUS_CANCELLED):
    for mtd in (0, 1, 3):
        for risk, dlp in ((1.0, 3.0), (1.0, 0.0), (0.0, 3.0), (2.0, 3.0), (0.5, 0.25), (3.0, 1.0)):
            for sig in (0, 1, 3, 4):
                for tr in (0.0, -0.99, -1.0, -1.5, -3.0, -6.0, -6.01, 2.0):
                    ch = C.Challenge(user_id=1, started_at=T0, deposit=1000.0, goal_kind="pct", goal_value=10.0,
                                     risk_pct=risk, max_trades_day=mtd, daily_loss_pct=dlp, status=status)
                    b, reason = C.discipline(ch, sig, tr)
                    disc.append([status, mtd, risk, dlp, sig, tr, b, reason, ch.daily_loss_r])
out["discipline"] = disc

day_ts = [T0, T0 - 1e-7, T0 - 4e-7, T0 - 5e-7, T0 - 6e-7, T0 + 86399.9999994, T0 + 86399.9999995,
          T0 + 86399.9999996, T0 + 0.5, T0 + 3599.9999996, T0 + 19 * 3600 + 3599.99999951, 0.0, 86399.9999995,
          1.7e9, 1_700_000_000.123456, -1.5, -86400.0000004]
out["days"] = [[t, C._day_start(t), C._day_key(t), __import__("datetime").datetime.fromtimestamp(
    t, tz=__import__("datetime").timezone.utc).hour] for t in day_ts]
usd_vals = [0, 0.0, -0.0, 0.4, 0.5, 1.5, 2.5, -0.4, -12.5, 999.5, 1000.5, 1234567.5, 12345.678, -98765.4321,
            1e9, 7, 100.0]
out["usd"] = [[v, C._usd(v)] for v in usd_vals]
bar_vals = [0, 0.0, 5, 5.0, 4.9, 15, 15.0, 25, 35, 45, 50, 55, 65, 95, 99.9, 100, 105, 250, -3, 14.999]
out["bar"] = [[v, C._bar(v)] for v in bar_vals]
out["block"] = {r: {lg: C.block_text(r, lg) for lg in ("ru", "en", "de")} for r in ("max_trades", "daily_loss")}

# questionnaire helpers
parse_inputs = ["2500", "2 500", "$2,500", "-3.5%", "abc", "", None, "1.2.3", "+7", "1,5", " 12 , 5", "x10y20",
                "٣", "0", "10 000 000", "５００", "𝟐,𝟓"]
out["parse_num"] = [[s, H._parse_num(s)] for s in parse_inputs]
ans_states = [{}, {"goal": "pct:10", "deposit": 500.0, "term": "2w", "risk": 1.0, "leverage": 5, "trades": 3,
                   "loss": 2.0, "topup": 100.0, "strategies": ["SMC"], "mode": "auto"},
              {"goal": "usd:2500.0", "deposit": 1000.0}, {"goal": "x"}, {"goal": "pct:abc"}, {"term": None},
              {"strategies": []}, {"goal": "usd:12:3"}, {"goal": ""}]
ans_out = []
for st_ in ans_states:
    try:
        ans_out.append({"state": st_, "ok": True, "answers": H._answers(st_)})
    except Exception as e:  # noqa: BLE001
        ans_out.append(dict(err(e), state=st_))
out["answers_from_state"] = ans_out
out["handler_texts"] = H._L
out["handler_options"] = {k: [list(x) for x in v] for k, v in H._OPTIONS.items()}
out["steps"] = list(H.STEPS)
out["custom_steps"] = list(H._CUSTOM_STEPS)
out["core_texts"] = C._T

# ════════════════════════════════════════════════════════════════════════
# 5. kv JSON: from_json / to_json round-trips
# ════════════════════════════════════════════════════════════════════════
base_ch = C.build(81, dict(BASE, term="3m", topup_monthly=99.99), now=T0 + 0.25)
base_ch.topups = [{"ts": T0 + 100.5, "amount": 10.0}, {"ts": T0 + 200.0, "amount": 1234.57}]
base_ch.notified = {"block:2026-01-01": int(T0 + 5), "daily:2026-01-01": int(T0 + 6)}
good = base_ch.to_json()
d_extra = json.loads(good)
d_extra["zzz"] = 1
d_extra["status"] = "актив \"q\" \\ \u0001 \u007f é"
d_reorder = dict(reversed(list(json.loads(good).items())))
d_min = {"user_id": 5, "started_at": T0, "deposit": 50.5, "goal_kind": "usd", "goal_value": 75.25}
raws = [good, json.dumps(d_extra), json.dumps(d_extra, ensure_ascii=False), json.dumps(d_reorder), json.dumps(d_min),
        '{"user_id": 5}', '{"user_id": 5, "started_at": 1.5}', '{"deposit": 1}', "null", "[]", '"x"', "", "not json",
        "{", "1", json.dumps(dict(d_min, strategies=["SMC", "VOLUME"], mode="auto", status="done",
                                  finished_at=T0 + 99.125, leverage=20, max_trades_day=0, term="2w",
                                  deadline_ts=T0 + 14 * 86400, daily_stop={"day": "2026-01-01", "reason": "x"}))]
fj = []
for raw in raws:
    try:
        ch = C.Challenge.from_json(raw)
        fj.append({"raw": raw, "ok": True, "json": ch.to_json() if ch is not None else None})
    except Exception as e:  # noqa: BLE001
        fj.append(dict(err(e), raw=raw))
out["from_json"] = fj
derived = []
for raw in [good, json.dumps(d_min)] + [p["json"] for p in plans[::7]]:
    ch = C.Challenge.from_json(raw)
    derived.append({"json": raw, "goal_usd": ch.goal_usd, "goal_profit_usd": ch.goal_profit_usd, "risk_usd": ch.risk_usd,
                    "r_needed": ch.r_needed, "topups_total": ch.topups_total, "daily_loss_r": ch.daily_loss_r,
                    "dict": M._challenge_dict(ch)})
out["derived"] = derived

# notify_once: flags + eviction above 60
KV: dict = {}


async def fake_save(ch):
    KV[C._key(ch.user_id)] = ch.to_json()


C.save = fake_save
ch = C.build(82, BASE, now=T0)
seq = []
keys_ = [f"daily:2026-01-{d:02d}" for d in range(1, 29)] + [f"block:2026-02-{d:02d}" for d in range(1, 29)] \
    + ["daily:2026-01-05", "block:2026-02-03"] + [f"daily:2026-03-{d:02d}" for d in range(1, 12)]
for i, k in enumerate(keys_):
    FAKE[0] = T0 + 1000 + (i * 37) % 500 + (i // 10) * 1000     # not monotonic: ties + reorders
    r = run(C.notify_once(ch, k))
    seq.append({"key": k, "clock": FAKE[0], "ret": r, "n": len(ch.notified), "json": KV.get(C._key(82))})
out["notify_once"] = {"start_json": C.build(82, BASE, now=T0).to_json(), "steps": seq}
FAKE[0] = T0

# add_topup / finish
tp = []
ch = C.build(83, BASE, now=T0)
for amt in (0.5, 1, 1.004, 1.005, 2.675, "12.5", "x", None, 10_000_000, 10_000_000.01, True, [1]):
    try:
        run(C.add_topup(ch, amt, now=T0 + 50.75))
        tp.append({"amount": amt, "ok": True, "json": ch.to_json(), "total": ch.topups_total})
    except Exception as e:  # noqa: BLE001
        tp.append(dict(err(e), amount=amt))
run(C.finish(ch, C.STATUS_CANCELLED, now=T0 + 999.5))
out["topup"] = {"start_json": C.build(83, BASE, now=T0).to_json(), "steps": tp, "finished_json": ch.to_json()}

# ════════════════════════════════════════════════════════════════════════
# 6. a seeded bot DB (signal_rows_since / signal_stats / missed_stats)
# ════════════════════════════════════════════════════════════════════════
tmp = tempfile.mkdtemp(prefix="m17a_challenge_")
DBP = os.path.join(tmp, "bot.db")
run(database.init_db(DBP))
DB_ROWS: list[dict] = []
_seq = [0]


def db_insert(uid, r):
    _seq[0] += 1
    row = dict(r)
    row["trade_id"] = f"c{_seq[0]:05d}_{uid}"
    row["user_id"] = uid
    DB_ROWS.append(row)
    con = sqlite3.connect(DBP)
    cols = sorted(row)
    con.execute(f"INSERT INTO trades ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", [row[c] for c in cols])
    con.commit()
    con.close()


# ════════════════════════════════════════════════════════════════════════
# 7. apply_settings truth table
# ════════════════════════════════════════════════════════════════════════
USER_FIELDS = ("trade_risk_pct", "trade_leverage", "auto_trade", "strategy", "extra_strategies", "long_active",
               "short_active", "smc_long_active", "smc_short_active", "vol_long_active", "vol_short_active",
               "active", "scan_mode")


def mk_user(uid, plan, init):
    u = UserSettings(user_id=uid)
    u.sub_plan = plan
    u.sub_status = "active"
    u.sub_expires = T0 + 30 * 86400
    for k, v in init.items():
        setattr(u, k, v)
    return u


INITS = [{}, {"strategy": "SMC", "smc_long_active": True}, {"strategy": "VOLUME", "vol_long_active": False,
                                                            "extra_strategies": "LEVELS"},
         {"strategy": "LEVELS", "long_active": False, "short_active": False, "extra_strategies": "SMC,VOLUME"},
         {"auto_trade": False, "trade_risk_pct": 2.5, "trade_leverage": 20}]
apply_cases = []
for uid, plan in ((501, "free"), (502, "pro"), (123, "free")):
    for init in INITS:
        for strats in (["LEVELS"], ["SMC", "VOLUME"], ["VOLUME", "LEVELS", "SMC"], ["SMC"], ["LEVELS", "LEVELS"]):
            for mode in ("signals", "auto"):
                for keys in (False, True):
                    u = mk_user(uid, plan, init)
                    if keys:
                        u.bingx_api_key, u.bingx_api_secret = "k" * 10, "s" * 10
                    ch = C.build(uid, dict(BASE, strategies=strats, mode=mode, risk_pct=1.5, leverage=7), now=T0)
                    res = run(C.apply_settings(u, ch, None))
                    apply_cases.append({"uid": uid, "plan": plan, "init": init, "strategies": strats, "mode": mode,
                                        "keys": keys, "res": res, "user": {k: getattr(u, k) for k in USER_FIELDS}})
out["apply"] = apply_cases
out["started_text"] = [{"res": c["res"], "ru": H._L["ru"]["started"] + "", "lang": lg,
                        "text": "\n".join([H._L[lg]["started"]] + ([H._L[lg]["applied"] + ", ".join(c["res"]["applied"])]
                                                                    if c["res"].get("applied") else [])
                                          + ([H._L[lg]["skipped"] + ", ".join(H._L[lg]["no_keys"] if x == "auto_trade" else x
                                                                             for x in c["res"]["skipped"])]
                                             if c["res"].get("skipped") else []))}
                       for c in apply_cases[::9] for lg in ("ru", "en")]

# ════════════════════════════════════════════════════════════════════════
# 8. tick(): a fake-clock timeline over several users
# ════════════════════════════════════════════════════════════════════════
KV.clear()


async def fake_load_all_active():
    res = []
    for _k, raw in list(KV.items()):
        c = C.Challenge.from_json(raw)
        if c is not None and c.status == C.STATUS_ACTIVE:
            res.append(c)
    return res


async def fake_load(uid):
    raw = KV.get(C._key(uid))
    return C.Challenge.from_json(raw) if raw else None


C.load_all_active = fake_load_all_active
C.load = fake_load
SENT: list = []
CARDS: list = []


async def fake_send(bot, uid, text):
    SENT.append([uid, text])


C._send = fake_send
import share_card  # noqa: E402


def fake_render(st, period, days, lang):
    CARDS.append({"stats": st, "period": period, "days": days, "lang": lang})
    return b"png"


share_card.render_share_png = fake_render


class FakeBot:
    async def send_photo(self, uid, photo):
        CARDS[-1]["uid"] = uid
        CARDS[-1]["filename"] = photo.filename


LANGS = {201: "ru", 202: "en", 203: "ru", 204: "en", 205: "ru", 206: "ru", 207: "en", 208: "de"}


class FakeUM:
    async def get_or_create(self, uid, username=""):
        if uid == 206:
            raise RuntimeError("user lookup failed")
        return SimpleNamespace(user_id=uid, lang=LANGS.get(uid, "ru"))

    async def save(self, user):
        return None


TICK_USERS = [
    (201, T0 + 9 * 3600, dict(BASE, max_trades_day=2, risk_pct=1, daily_loss_pct=3, term="1m", goal_value=25)),
    (202, T0 + 3600, dict(BASE, max_trades_day=0, risk_pct=1, daily_loss_pct=2, term="1m", goal_value=50)),
    (203, T0 + 1800, dict(BASE, max_trades_day=0, risk_pct=2, daily_loss_pct=0, term="3m", goal_value=10)),
    (204, T0, dict(BASE, term="2w", goal_value=100)),
    (205, T0, dict(BASE, term="2w", goal_value=100)),
    (206, T0, dict(BASE, term="none")),
    (207, T0 + 600, dict(BASE, term="none", max_trades_day=0, daily_loss_pct=0, goal_value=500)),
    (208, T0 + 7200, dict(BASE, term="none", topup_monthly=50)),
]
for uid, st0, a in TICK_USERS:
    FAKE[0] = st0
    run(fake_save(C.build(uid, a, now=st0)))
KV["challengeX9"] = "{broken"            # LIKE 'challenge_%' matches (`_` = any char); from_json → None
H_ = 3600
D_ = 86400


def tp3_row(created):
    return {"result": "", "result_rr": 0.0, "progress_stage": "TP3", "entry": 100.0, "sl": 98.0, "original_sl": 98.0,
            "tp1": 102.0, "tp2": 104.0, "tp3": 105.0, "created_at": created, "strategy": "LEVELS", "order_id": "",
            "signal_msg_id": 11, "symbol": "BTC-USDT-SWAP", "direction": "LONG", "expire_rr": None}


def stage_row(created, stage, strat="SMC"):
    r = tp3_row(created)
    r.update(progress_stage=stage, strategy=strat, symbol="ETH-USDT-SWAP")
    return r


EVENTS = [
    (T0 + 3 * H_, [(203, tp3_row(T0 + 2 * H_))]),
    (T0 + 4 * H_, [(203, tp3_row(T0 + 3.5 * H_)), (202, stage_row(T0 + 3.9 * H_, "SL"))]),
    (T0 + 6 * H_, [(202, stage_row(T0 + 5.5 * H_, "SL"))]),
    (T0 + 10 * H_, [(201, stage_row(T0 + 9.5 * H_, ""))]),
    (T0 + 11 * H_, [(201, stage_row(T0 + 10.5 * H_, "TP1"))]),
    (T0 + 12 * H_, []),
    (T0 + 20.5 * H_, [(204, stage_row(T0 + 20 * H_, "BE")), (999, stage_row(T0 + 20 * H_, "SL"))]),
    (T0 + 21 * H_, []),
    (T0 + D_ + 10 * H_, []),
    (T0 + D_ + 20 * H_ + 300, [(207, stage_row(T0 + D_ + 20 * H_, "MISSED", "VOLUME"))]),
    (T0 + D_ + 20 * H_ + 900, []),
    (T0 + 2 * D_ + 8 * H_, [(201, stage_row(T0 + 2 * D_ + 7 * H_, "SL")), (201, stage_row(T0 + 2 * D_ + 7.5 * H_, "SL"))]),
    (T0 + 2 * D_ + 23.99 * H_, []),
    (T0 + 14 * D_ + H_, []),
]
for d in range(3, 70):
    EVENTS.append((T0 + d * D_ + 20 * H_ + 1800, []))
timeline = []
for t, adds in EVENTS:
    FAKE[0] = t
    for uid, r in adds:
        db_insert(uid, r)
    SENT.clear()
    CARDS.clear()
    st = run(C.tick(FakeBot(), FakeUM(), now=t))
    gates = {}
    for uid in (201, 202, 203, 208):
        gates[uid] = run(C.gate(uid, now=t))
    timeline.append({"t": t, "adds": [[u, r] for u, r in adds], "stats": st, "sent": list(SENT), "cards": list(CARDS),
                     "kv": {k: v for k, v in KV.items() if k.startswith("challenge_")}, "gates": gates})
out["tick"] = {"users": [[u, s, a] for u, s, a in TICK_USERS], "langs": LANGS, "timeline": timeline}


# gate: kv read failure → fail-open (None); progress error → raises
async def boom_load(uid):
    raise RuntimeError("kv down")


C.load = boom_load
out["gate_kv_fail"] = run(C.gate(201, now=T0 + 11 * H_))
C.load = fake_load

# daily summary line (progress short) for the active users at the end
FAKE[0] = T0 + 70 * D_
out["daily_line"] = {}
for uid in (201, 202, 207, 208):
    ch = run(fake_load(uid))
    rows = run(SS.signal_rows_since(uid, ch.started_at))
    lg = LANGS[uid]
    out["daily_line"][uid] = C.progress_text(ch, C.progress(ch, rows), lg if lg == "en" else "ru", short=True) \
        if ch.status == C.STATUS_ACTIVE else None

# ════════════════════════════════════════════════════════════════════════
# 9. Mini App routes replay (h_challenge_get / post / topup / finish)
# ════════════════════════════════════════════════════════════════════════
KV.clear()
M._RATE.clear()
ROUTE_USERS = {301: mk_user(301, "pro", {}), 302: mk_user(302, "free", {}), 123: mk_user(123, "free", {}),
               303: mk_user(303, "pro", {})}
ROUTE_INIT = {uid: {k: getattr(u, k) for k in USER_FIELDS} for uid, u in ROUTE_USERS.items()}
CUR = {"uid": 301}


async def fake_load_user(request):
    uid = CUR["uid"]
    if request.method == "POST" and not M._rate_ok(uid, "post", *M.POST_RATE_LIMIT):
        raise M._rate_limited_response(10)
    return {"id": uid}, ROUTE_USERS[uid]


M._load_user = fake_load_user


class FakeUMRoutes:
    async def save(self, user):
        return None


M._ctx["um"] = FakeUMRoutes()


class Req:
    def __init__(self, method, body=None):
        self.method = method
        self._body = body

    async def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


HANDLERS = {"GET challenge": M.h_challenge_get, "POST challenge": M.h_challenge_post,
            "POST challenge/topup": M.h_challenge_topup, "POST challenge/finish": M.h_challenge_finish}
# rows of the route user (plan stats + progress)
for k in range(14):
    r = mk_row(T0 - rng.uniform(0, 25) * D_)
    db_insert(301, r)
for k in range(3):
    db_insert(301, mk_row(T0 + 1000 + k * 10, rng.choice(["open", "sl", "tp3"])))
STEPS_ = [
    (302, "GET challenge", None), (302, "POST challenge", dict(BASE)),
    (301, "GET challenge", None),
    (301, "POST challenge", {"deposit": "abc"}), (301, "POST challenge", {}),
    (301, "POST challenge", dict(BASE, strategies=[])), (301, "POST challenge", dict(BASE, leverage="5.5")),
    (301, "POST challenge", dict(BASE, leverage=[5])), (301, "POST challenge", ["not", "a", "dict"]),
    (301, "POST challenge", dict(BASE, preview=True, mode="auto", risk_pct=3, leverage=50, junk=1)),
    (301, "GET challenge", None),
    (301, "POST challenge", dict(BASE, mode="auto", strategies=["SMC", "LEVELS"], max_trades_day=2)),
    (301, "POST challenge", dict(BASE)),
    (301, "POST challenge/topup", {"amount": "abc"}), (301, "POST challenge/topup", {"amount": 0}),
    (301, "POST challenge/topup", {}), (301, "POST challenge/topup", {"amount": 0.99}),
    (301, "POST challenge/topup", {"amount": "250.555"}), (301, "POST challenge/topup", {"amount": [1]}),
    (301, "GET challenge", None),
    (301, "POST challenge", dict(BASE, replace=True, mode="signals", strategies=["VOLUME"], term="none", preview=0)),
    (301, "POST challenge/finish", None), (301, "POST challenge/finish", None),
    (301, "POST challenge/topup", {"amount": 5}), (301, "GET challenge", None),
    (301, "POST challenge", dict(BASE, term="2w")),
    (123, "POST challenge", dict(BASE, mode="auto", strategies=["VOLUME", "SMC"])),
    (123, "GET challenge", None), (302, "POST challenge/finish", None),
] + [(303, "GET challenge", None)] * 11
replay = []
for i, (uid, route, body) in enumerate(STEPS_):
    FAKE[0] = T0 + 2000 + i
    CUR["uid"] = uid
    method = route.split(" ")[0]
    req = Req(method, body)
    try:
        resp = run(HANDLERS[route](req))
        status, payload = resp.status, json.loads(resp.body)
    except web.HTTPException as e:
        status, payload = e.status, json.loads(e.text)
    replay.append({"uid": uid, "route": route, "body": body, "now": FAKE[0], "status": status, "json": payload,
                   "kv": KV.get(C._key(uid)),
                   "user": {k: getattr(ROUTE_USERS[uid], k) for k in USER_FIELDS}})
out["routes"] = {"init": ROUTE_INIT, "plans": {u: x.sub_plan for u, x in ROUTE_USERS.items()}, "steps": replay}

# ════════════════════════════════════════════════════════════════════════
# 10. entry advisor
# ════════════════════════════════════════════════════════════════════════
ENVS = [{}, {"ENTRY_ADVISOR_DAYS": "1"}, {"ENTRY_ADVISOR_DAYS": ""}, {"ENTRY_ADVISOR_DAYS": " 21 "},
        {"ENTRY_ADVISOR_MIN_SHARE": "0.01"}, {"ENTRY_ADVISOR_MIN_SHARE": "0.95"}, {"ENTRY_ADVISOR_MIN_SHARE": "nan"},
        {"ENTRY_ADVISOR_ENABLED": "off"}, {"ENTRY_ADVISOR_ENABLED": "FALSE"}, {"ENTRY_ADVISOR_ENABLED": " 0 "},
        {"ENTRY_ADVISOR_ENABLED": ""}, {"ENTRY_ADVISOR_INTERVAL_S": "10"}, {"ENTRY_ADVISOR_REPEAT_DAYS": "0"},
        {"ENTRY_ADVISOR_MIN_MISSED": "1"}, {"ENTRY_ADVISOR_MIN_MISSED": "9"}, {"ENTRY_ADVISOR_DAYS": "abc"},
        {"ENTRY_ADVISOR_INTERVAL_S": "1e4"}, {"ENTRY_ADVISOR_DAYS": "14.0"}]
env_out = []
KEYS_ENV = ("ENABLED", "DAYS", "MIN_MISSED", "MIN_SHARE", "REPEAT_DAYS", "INTERVAL_S")
for env in ENVS:
    saved = {k: os.environ.pop(k) for k in list(os.environ) if k.startswith("ENTRY_ADVISOR_")}
    os.environ.update(env)
    try:
        importlib.reload(EA)
        env_out.append({"env": env, "ok": True, "cfg": {k: getattr(EA, k) for k in KEYS_ENV}})
    except Exception as e:  # noqa: BLE001
        env_out.append(dict(err(e), env=env))
    for k in env:
        os.environ.pop(k, None)
    os.environ.update(saved)
importlib.reload(EA)
out["advisor_env"] = env_out
pick_cases = [{}, {"LEVELS": {"missed": 5, "total": 10}}, {"LEVELS": {"missed": 4, "total": 4}},
              {"LEVELS": {"missed": 5, "total": 17}}, {"LEVELS": {"missed": 6, "total": 20}},
              {"LEVELS": {"missed": 6, "total": 0}}, {"SMC": {"missed": 9, "total": 30}, "LEVELS": {"missed": 6, "total": 20}},
              {"LEVELS": {"missed": 6, "total": 20}, "SMC": {"missed": 9, "total": 30}},
              {"LEVELS": {"missed": 5, "total": 10}, "SMC": {"missed": 6, "total": 10}, "VOLUME": {"missed": 10, "total": 11}},
              {"VOLUME": {"missed": 10}}, {"VOLUME": {"total": 10}}, {"X": {"missed": 50, "total": 60}}]
for _ in range(60):
    pick_cases.append({s: {"missed": rng.randint(0, 12), "total": rng.randint(0, 30)} for s in EA.STRATS if rng.random() < 0.8})
out["advisor_pick"] = [[c, EA.pick_advice(c)] for c in pick_cases]
texts = []
for s in ("LEVELS", "SMC", "VOLUME", "X<&>"):
    for m, t in ((5, 10), (1, 8), (3, 8), (7, 9), (5, 0), (12, 13)):
        for lg in ("ru", "en", "de"):
            texts.append([s, m, t, lg, EA.advice_text(s, m, t, lg)])
out["advisor_text"] = texts
# missed_stats over seeded rows (uid 401..404)
FAKE[0] = T0 + 40 * D_
ADV_ROWS = []
for uid in (401, 402, 403, 404):
    for k in range(rng.randint(8, 30)):
        created = FAKE[0] - rng.choice([rng.uniform(0, 13.9 * D_), rng.uniform(14.1 * D_, 30 * D_), 14 * D_])
        r = {"symbol": "BTC-USDT-SWAP", "direction": "LONG", "entry": 1.0, "sl": 0.98, "tp1": 1.02, "tp2": 1.04,
             "tp3": 1.06, "created_at": created,
             "strategy": rng.choice(["LEVELS", "SMC", "VOLUME", "smc", "", None, "GERCHIK"]),
             "progress_stage": rng.choice(["MISSED", "MISSED", "missed", "", None, "TP1", "SL"]),
             "signal_msg_id": rng.choice([0, None, 5, 6, 7])}
        if uid == 402:
            r.update(strategy="SMC", progress_stage=rng.choice(["MISSED", "MISSED", "TP1"]), signal_msg_id=9,
                     created_at=FAKE[0] - rng.uniform(0, 10 * D_))
        db_insert(uid, r)
        ADV_ROWS.append(DB_ROWS[-1])
missed = {uid: run(EA.missed_stats(uid)) for uid in (401, 402, 403, 404, 405)}
out["advisor_missed"] = {"now": FAKE[0], "stats": missed}
# advise_user branches
ADV_KV: dict = {}
ADV_SENT: list = []
SEND_OK = [True]


async def kv_get(k):
    v = ADV_KV.get(k)
    if v == "RAISE":
        raise RuntimeError("kv down")
    return v


async def kv_set(k, v):
    ADV_KV[k] = v


database.db_kv_get = kv_get
database.db_kv_set = kv_set
import telegram_safe  # noqa: E402


async def fake_safe_send(bot, uid, text, **kw):
    rm = kw.get("reply_markup")
    ADV_SENT.append({"uid": uid, "text": text, "disable_notification": kw.get("disable_notification"),
                     "buttons": [[b.text, b.callback_data] for row in rm.inline_keyboard for b in row] if rm else None})
    return SEND_OK[0]


telegram_safe.safe_send_message = fake_safe_send
ADV_CASES = [
    ("prefer_on", 402, {"prefer_market_entry": True}, None, True),
    ("recent", 402, {}, str(int(FAKE[0] - 6 * D_)), True),
    ("exact_7d", 402, {}, str(int(FAKE[0] - 7 * D_)), True),
    ("garbage_kv", 402, {}, "garbage", True),
    ("kv_raises", 402, {}, "RAISE", True),
    ("float_kv", 402, {}, f"{FAKE[0] - 8 * D_:.3f}", True),
    ("no_pick", 403, {}, None, True),
    ("send_fails", 402, {}, None, False),
    ("quiet", 402, {"quiet_start": 0, "quiet_end": 23}, None, True),
    ("quiet_wrap", 402, {"quiet_start": 22, "quiet_end": 1}, None, True),
    ("en", 402, {"lang": "en"}, None, True),
    ("de", 402, {"lang": "de"}, None, True),
    ("lang_empty", 402, {"lang": ""}, None, True),
    ("uid0", 0, {}, None, True),
    ("u401", 401, {}, None, True), ("u404", 404, {}, None, True),
]
adv_out = []
for name, uid, attrs, kv0, ok in ADV_CASES:
    ADV_KV.clear()
    ADV_SENT.clear()
    if kv0 is not None:
        ADV_KV[f"{EA.KV_PREFIX}{uid}"] = kv0
    SEND_OK[0] = ok
    u = UserSettings(user_id=uid)
    for k, v in attrs.items():
        setattr(u, k, v)
    r = run(EA.advise_user(None, u, now=FAKE[0]))
    adv_out.append({"name": name, "uid": uid, "attrs": attrs, "kv0": kv0, "send_ok": ok, "ret": r,
                    "sent": list(ADV_SENT), "kv": dict(ADV_KV)})
out["advisor_advise"] = {"now": FAKE[0], "cases": adv_out}

out["db_rows"] = DB_ROWS
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=0, sort_keys=False)
print("wrote", OUT, "validation", len(validation), "plan", len(plans), "progress", len(progress_cases),
      "timeline", len(timeline), "routes", len(replay), "db rows", len(DB_ROWS))
os._exit(0)   # aiosqlite pool threads would keep the interpreter alive
