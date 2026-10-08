"""gen_verify_vectors.py — adversarial parity vectors for the M17a verification pass
(backend/tests/challenge/verify.test.js). Independent of gen_challenge_vectors.py: its own
seed, a much wider input domain and the bot's real kv / trades tables everywhere.

  A  build + plan + plan_text + _challenge_dict   300 random answer sets (valid, boundary and
     hostile values: Unicode digits / spaces of every kind, PEP 515 underscores, > 4300-digit
     ints, 200-char repr truncation, non-printable characters, quotes, wrong types)
  B  progress + progress_text + block_text        100 random row sets (every outcome branch)
  C  discipline                                   200 random (trades today, R today, limits)
  D  gate                                         200 users on the real kv + trades tables
  E  tick                                         30 simulated days, 10 challenges, fake wall
     clock (messages, cards, counters, notified flags, kv JSON byte-identical, gate per tick)
  F  kv JSON                                      to_json / from_json round trips
  G  entry advisor                                50 random MISSED histories (SQL, pick, text,
     send branches, kv) + 40 random ENTRY_ADVISOR_* environments
  H  questionnaire helpers                        _parse_num / _answers on random input
  I  Mini App routes                              a random request sequence through the bot's own
     h_challenge_get / post / topup / finish (rate buckets included)

Run with the bot's venv (the script chdirs into the bot checkout itself):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python gen_verify_vectors.py ../fixtures/verify_vectors.json.gz
afterwards: rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
import random
import re
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
for _k in [k for k in os.environ if k.startswith(("CHALLENGE_", "ENTRY_ADVISOR_", "SIGNAL_TRACKER_"))]:
    os.environ.pop(_k)

import faulthandler  # noqa: E402
faulthandler.dump_traceback_later(900, exit=True)

import challenge as C  # noqa: E402
import database  # noqa: E402
import entry_advisor as EA  # noqa: E402
import handlers.challenge as H  # noqa: E402
import miniapp_api as M  # noqa: E402
from aiohttp import web  # noqa: E402
from db import signal_stats as SS  # noqa: E402
from user_manager import UserSettings  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else "verify_vectors.json.gz"
rng = random.Random(0xC4A11E7)
T0 = 1_768_435_200.0                      # 2026-01-15 00:00:00 UTC
FAKE = [T0]
_time.time = lambda: FAKE[0]
D_ = 86400.0
H_ = 3600.0
out: dict = {"t0": T0}


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


class _Cap(logging.Handler):
    """INFO / WARNING lines of the challenge, Mini App and advisor loggers (the log markers)."""

    def __init__(self):
        super().__init__(logging.INFO)
        self.lines: list = []

    def emit(self, record):
        self.lines.append([record.levelname.lower(), record.getMessage()])

    def take(self):
        out, self.lines = self.lines, []
        return out


CAP = _Cap()
for _name in ("CHM.Challenge", "CHM.MiniApp", "CHM.EntryAdvisor"):
    _lg = logging.getLogger(_name)
    _lg.addHandler(CAP)
    _lg.setLevel(logging.INFO)
    _lg.propagate = False


tmp = tempfile.mkdtemp(prefix="m17a_verify_")
DBP = os.path.join(tmp, "bot.db")
run(database.init_db(DBP))
_con = sqlite3.connect(DBP)
_con.execute("DELETE FROM kv WHERE key LIKE 'challenge%' OR key LIKE 'entry_advice%'")
_con.commit()
DB_ROWS: list[dict] = []
_seq = [0]
UIDS: set = set()


def db_insert(uid, r):
    _seq[0] += 1
    row = dict(r)
    row["trade_id"] = f"v{_seq[0]:06d}_{uid}"
    row["user_id"] = uid
    UIDS.add(uid)
    DB_ROWS.append(row)
    cols = sorted(row)
    _con.execute(f"INSERT INTO trades ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", [row[c] for c in cols])
    _con.commit()
    return row["trade_id"]


def db_update(trade_id, fields):
    sets = ", ".join(f"{k}=?" for k in sorted(fields))
    _con.execute(f"UPDATE trades SET {sets} WHERE trade_id=?", [fields[k] for k in sorted(fields)] + [trade_id])
    _con.commit()


def kv_snapshot(prefix="challenge"):
    return {k: v for k, v in _con.execute("SELECT key, value FROM kv WHERE key LIKE ?", (prefix + "%",)).fetchall()}


# ════════════════════════════════════════════════════════════════════════
# value pools
# ════════════════════════════════════════════════════════════════════════
WEIRD = [
    " 12 ", "1_000", "1__0", "_1", "1_", "1e3", "1E-2", "1e1_0", ".5", "5.", "+.5", "-0", "0x10", "1,5", "inf",
    "-Infinity", "nan", "NaN", "iNf", "infinity", "  nan  ", "1e400", "-1e400", "+5", "--5", "5-", "1 000", "0012",
    "١٢٣", "１２３", "𝟏𝟎", "٣٫٥", "١e٢", "๑๒", "߁߀", "\U00010d41\U00010d40", "\U00016d71\U00016d70",
    "\U0001ccf5", "\U000116d3", "\U00011bf1", "\U00016131",
    "\x8512", "12\x85", "\xa012", "\U0000200312\U00003000", "\U0000feff12", "12\U0000feff", "\x1c12", "12\x1f", "\U0000180e12",
    "\U0000200b12", "\t12\n", "\x0b12\x0c", "\r12", "\U00002028" + "7", "7\U00002029",
    "x" * 199, "x" * 200, "x" * 201, "1" * 4300, "1" * 4301, "0" * 4301, "1_" * 2200 + "1", "٣" * 4301,
    "1" * 4301 + "x", "1" * 4400 + ".", "\x00" * 120, "é" * 230,
    "\x00", "\x7f", "a\x9fb", "a\xadb", "\U00002028", "\U0000e000", "\U000e0001", "\ud800", "\udfff", "\U00000378",
    "\U00010d40x", "\U0003fffd", "\U00016d40", "\U0001f600",
    "it's", 'say "hi"', "both ' and \"", "a\\b", "😀", "é", "—", "\n", "abc", "5.5", "5.0", "7", "125", "126",
    "0.1", "10", "10000000", "1e7", "9.999", "10.001", "0.09", "100.0", "-5", "3", "50", "50.01",
]
ODD = [None, "", 0, 0.0, -0.0, True, False, [], {}, [1], {"a": 1}, [None], "None", "null", [[]], {"": 0}]
NUMS = [-1, -0.5, 1e-9, 1e15, -1e15, 123456789.123, 2.675, 1.005, 0.125, 0.005, 9.995, 10.005, 0.1, 0.09999,
        10, 10.0, 125, 125.9, 126, 1, 0.9999, 50, 50.0001, 100, 101, 1e7, 1e7 + 0.01, 5e-324, 1.7e308]


def adv_value():
    k = rng.random()
    if k < 0.4:
        return rng.choice(WEIRD)
    if k < 0.6:
        return rng.choice(ODD)
    if k < 0.85:
        return rng.choice(NUMS)
    return rng.choice([rng.uniform(-100, 2e7), rng.randint(-5, 200), round(rng.uniform(0, 1000), rng.randint(0, 5))])


def as_repr(x):
    """A numeric value in one of the shapes a client may send it."""
    k = rng.random()
    if k < 0.55:
        return x
    if k < 0.8:
        return str(x)
    if k < 0.88:
        return f" {x} "
    if k < 0.94 and float(x) == int(float(x)) and abs(x) < 1e12:
        return str(int(float(x))).translate(str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩"))
    return f"{x}".replace("00", "0_0") if "00" in f"{x}" and "." not in f"{x}" else x


def v_deposit():
    return rng.choice([10, 10.0, 1e7, 10_000_000, 10.004, 10.005, 1234.565, 1234.575, 267.5,
                       round(rng.uniform(10, 1e5), rng.randint(0, 4)), rng.uniform(10, 1e7),
                       rng.randint(10, 10 ** 6), rng.uniform(10, 500)])


def rand_answers(p_valid):
    dep = v_deposit()
    kind = rng.choice(["pct", "pct", "usd"])
    if kind == "pct":
        gv = rng.choice([1, 1.0, 1000, 999.995, 1.005, 12.345, rng.uniform(1, 1000), rng.randint(1, 1000), 25, 100])
    else:
        gv = dep * rng.choice([100.0, 1.0000001, 1.5, 2, 10, rng.uniform(1.001, 100)])
    valid = {
        "deposit": as_repr(dep), "goal_kind": kind, "goal_value": as_repr(gv),
        "term": rng.choice(list(C.TERMS_DAYS)),
        "risk_pct": as_repr(rng.choice([0.1, 0.1001, 10, 10.0, 0.125, 2.345, 3, 2.99, 0.105, 0.115, rng.uniform(0.1, 10)])),
        "leverage": as_repr(rng.choice([1, 125, 1.9999, 5.9, 125.9, 33, 34, 50, rng.randint(1, 125)])),
        "max_trades_day": as_repr(rng.choice([0, 1, 3, 100, 100.9, rng.randint(0, 100)])),
        "daily_loss_pct": as_repr(rng.choice([0, 0.0, 0.005, 0.004, 2.345, 50, 50.0, rng.uniform(0, 50)])),
        "topup_monthly": as_repr(rng.choice([0, 0.0, 99.995, 1e7, rng.uniform(0, 1e5)])),
        "strategies": rng.choice([["LEVELS"], ["SMC"], ["VOLUME"], ["SMC", "LEVELS"], ["VOLUME", "SMC", "LEVELS"],
                                  ["LEVELS", "LEVELS"], {"VOLUME": 1}, ["X", "SMC"], [None, "VOLUME", 5]]),
        "mode": rng.choice(["signals", "auto"]),
    }
    adv = {
        "goal_kind": ["usd", "USD", "pct ", " pct", "usd\u200b", 5, 0, None, "", True, ["usd"], {"usd": 1}, "Pct"],
        "term": ["none", "None", "NONE", "2W", "1m ", "3m", "", None, 0, 14, ["1m"], "1w"],
        "deposit": [9.995, 9.99, 10_000_000.01, 1e7 + 1e-9, "9.99", "10_000_000.01"] + WEIRD[:40],
        "risk_pct": [0.099, 0.09999, 10.001, 10.0000001, "0.0999"] + WEIRD[40:80],
        "mode": ["auto", "AUTO", "signal", "", None, 0, 1, ["auto"], True, "signals\n"],
        "strategies": [None, [], ["X"], "LEVELS", "LEVELSSMC", {"SMC": 1, "LEVELS": 0}, {"X": 1}, 5, 7, True, 1.5,
                       -2.25, [["LEVELS"]], ["levels"], "", {}, 0, False, ["SMC", "SMC", "VOLUME"], [1, 2], "VOLUME"],
    }
    a = {}
    for f in ("deposit", "goal_kind", "goal_value", "term", "risk_pct", "leverage", "max_trades_day",
              "daily_loss_pct", "topup_monthly", "strategies", "mode"):
        if rng.random() < 0.03:
            continue
        if rng.random() < p_valid:
            a[f] = valid[f]
        elif f in adv:
            a[f] = rng.choice(adv[f])
        else:
            a[f] = adv_value()
    return a


def rand_stats():
    r = rng.random()
    if r < 0.08:
        return None
    if r < 0.12:
        return {}
    st = {"trades": rng.choice([0, 5, 9, 10, 11, 25, 100, rng.randint(0, 60), 10.7, None]),
          "total_rr": rng.choice([0.0, -0.0, 1e-9, -1e-9, rng.uniform(-30, 60), round(rng.uniform(-30, 60), 2),
                                  0.3, 30.0, -5.5, None, 3.0, 300.0])}
    if rng.random() < 0.1:
        st.pop("total_rr")
    return st


# ════════════════════════════════════════════════════════════════════════
# A. build + plan
# ════════════════════════════════════════════════════════════════════════
build_cases = []
n_ok = 0
for i in range(300):
    a = rand_answers(0.99 if i < 200 else 0.6)
    uid = rng.choice([1, 77, 4242, 2 ** 31 - 1, 10 ** 12])
    now = T0 + rng.choice([0.0, rng.uniform(-1e5, 1e6), round(rng.uniform(0, 1e6), 6), 0.5, 86399.9999995])
    rec = {"answers": a, "uid": uid, "now": now}
    try:
        ch = C.build(uid, a, now=now)
    except Exception as e:  # noqa: BLE001
        rec.update(err(e))
        rec["bad_ru"] = H._L["ru"]["bad"] + str(e)
        build_cases.append(rec)
        continue
    n_ok += 1
    rec.update(ok=True, json=ch.to_json(), dict=M._challenge_dict(ch), plans=[])
    for _ in range(2):
        st = rand_stats()
        dl = ch.deadline_ts
        pn = rng.choice([now, now + rng.uniform(0, 40 * D_), now - rng.uniform(0, 3 * D_),
                         (dl - D_) if dl else now, dl if dl else now, (dl + rng.uniform(0, 5 * D_)) if dl else now + 1,
                         (dl - 0.5 * D_) if dl else now])
        pl = C.plan(ch, st, now=pn)
        rec["plans"].append({"stats": st, "now": pn, "plan": pl, "ru": C.plan_text(ch, pl, "ru"),
                             "en": C.plan_text(ch, pl, "en"), "de": C.plan_text(ch, pl, "de")})
    build_cases.append(rec)
out["build"] = build_cases
print("build ok", n_ok, "of", len(build_cases), file=sys.stderr)

# ════════════════════════════════════════════════════════════════════════
# B. progress on random rows (pure)
# ════════════════════════════════════════════════════════════════════════
SYMS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "1000PEPE-USDT-SWAP", "DOGE-USDT", "XRP-USDT-SWAP-USDT-SWAP"]


def rand_row(created, pure=True):
    d = rng.choice(["LONG", "SHORT", "long", "short"])
    s = 1 if d.upper() == "LONG" else -1
    e = rng.choice([100.0, 2.5, 65000.0, 0.01234, 1.0, 3.3333])
    risk = e * rng.uniform(0.002, 0.03)
    r = {"result": "", "result_rr": 0.0, "progress_stage": "", "entry": e, "sl": e - s * risk,
         "original_sl": rng.choice([e - s * risk, None, e - s * risk * 1.3]),
         "tp1": e + s * risk * rng.choice([1.0, 1.5, 2.0, 1.27]), "tp2": e + s * risk * rng.choice([2.5, 3.0, 2.333]),
         "tp3": e + s * risk * rng.choice([4.0, 4.5, 5.111]), "created_at": created,
         "strategy": rng.choice(["LEVELS", "SMC", "VOLUME", "", "smc", "Volume", "GERCHIK"]),
         "order_id": "", "signal_msg_id": rng.choice([rng.randint(1, 999), 0, 1]), "symbol": rng.choice(SYMS),
         "direction": d, "expire_rr": None}
    k = rng.choice(["stage"] * 5 + ["exchange"] * 2 + ["skip", "manual", "weird"])
    if k == "stage":
        r["progress_stage"] = rng.choice(["", "", "ENTRY", "TP1", "TP2", "TP3", "SL", "SL", "BE", "EXPIRED", "MISSED",
                                          "tp2", "sl", "missed", "expired"])
        if r["progress_stage"].upper() == "EXPIRED":
            r["expire_rr"] = rng.choice([None, round(rng.uniform(-1, 2.5), 3), -0.004, 1.005, 2.675])
    elif k == "exchange":
        r["order_id"] = rng.choice([f"ox{rng.randint(1, 10 ** 6)}", "  ", "0"])
        r["result"] = rng.choice(["", "TP1", "TP3", "SL", "BE", "MANUAL", "TRAIL", "CLOSED", "LIQ", "tp2"])
        r["result_rr"] = rng.choice([0.0, 1.5, -1.0, -0.004, 0.004, rng.uniform(-2, 5), None, 3, -0.0])
    elif k == "skip":
        r["result"] = "SKIP"
        r["signal_msg_id"] = rng.choice([7, 0])
        r["order_id"] = rng.choice(["", "o1"]) if r["signal_msg_id"] == 0 else ""
        if pure and rng.random() < 0.4:
            r["skip_reason"] = rng.choice(["manual", "", None, "ghost"])
    elif k == "manual":
        r["result"] = rng.choice(["TP2", "SL", "BE", "ORPHAN"])
        r["result_rr"] = {"TP2": 3.0, "SL": -1.0, "BE": 0.0, "ORPHAN": 0.0}[r["result"]]
    else:
        r["progress_stage"] = rng.choice(["TP1", "TP3", "SL", ""])
        r["entry"] = rng.choice([r["entry"], 0.0])
        r["original_sl"] = rng.choice([r["entry"], 0.0, None])
        r["sl"] = rng.choice([r["sl"], r["entry"]])
        r["tp1"] = rng.choice([r["tp1"], 0.0, -1.0])
    if pure and rng.random() < 0.08:
        r["signal_msg_id"] = rng.choice(["5", "x", None, -3, 2.5])
    if pure and rng.random() < 0.05:
        r["strategy"] = None
        r["symbol"] = None
        r["direction"] = None
    return r


def rand_challenge(uid, started):
    a = rand_answers(1.0)
    while True:
        try:
            return C.build(uid, a, now=started)
        except Exception:  # noqa: BLE001
            a = rand_answers(1.0)


progress_cases = []
for i in range(100):
    started = T0 + rng.uniform(-2 * D_, 3 * D_)
    ch = rand_challenge(900 + i, started)
    if rng.random() < 0.3:
        ch.max_trades_day = rng.choice([1, 2, 3])
        ch.daily_loss_pct = rng.choice([0.5, 1.0, 2.0])
        ch.risk_pct = rng.choice([0.5, 1.0])
    if rng.random() < 0.35:
        for _ in range(rng.randint(1, 4)):
            ch.topups.append({"ts": started + rng.uniform(0, D_), "amount": round(rng.uniform(1, 5000), 2)})
    if rng.random() < 0.1:
        ch.status = rng.choice([C.STATUS_DONE, C.STATUS_CANCELLED, C.STATUS_EXPIRED])
    now = started + rng.choice([rng.uniform(0, H_), rng.uniform(0, 5 * D_), rng.uniform(5 * D_, 120 * D_),
                                (ch.deadline_ts - started) if ch.deadline_ts else 0.0, -rng.uniform(0, H_)])
    mid = C._day_start(now)
    rows = [rand_row(rng.uniform(started - D_, now + H_)) for _ in range(rng.randint(0, 28))]
    for kd in rng.choice([[], ["SL"], ["SL", "SL"], ["SL", "SL", "SL"], ["", "", ""], ["TP3", "SL"], ["SL"] * 6]):
        r = rand_row(rng.uniform(max(mid, started), max(now, started)))
        r.update(progress_stage=kd, result="", order_id="", signal_msg_id=3)
        rows.append(r)
    rng.shuffle(rows)
    pr = C.progress(ch, rows, now=now)
    progress_cases.append({"json": ch.to_json(), "rows": rows, "now": now, "progress": pr,
                           "ru": C.progress_text(ch, pr, "ru"), "en": C.progress_text(ch, pr, "en"),
                           "ru_short": C.progress_text(ch, pr, "ru", short=True),
                           "en_short": C.progress_text(ch, pr, "en", short=True),
                           "block_ru": C.block_text(pr["block_reason"], "ru") if pr["blocked"] else None,
                           "block_en": C.block_text(pr["block_reason"], "en") if pr["blocked"] else None})
# pinned edge: pace = round(0.57 - 0.6, 1) = -0.0 → "темп +-0.0R" (the sign test passes, str() keeps the sign)
_ch = C.build(1, {"deposit": 1000, "goal_kind": "pct", "goal_value": 6, "term": "2w", "risk_pct": 1, "leverage": 5,
                  "strategies": ["LEVELS"]}, now=T0)
_rows = [{"result": "MANUAL", "result_rr": 0.57, "order_id": "x", "created_at": T0 + 100, "strategy": "LEVELS",
          "signal_msg_id": 1, "symbol": "BTC-USDT-SWAP", "direction": "LONG", "entry": 1.0, "sl": 0.9, "tp1": 1.1,
          "tp2": 1.2, "tp3": 1.3}]
_now = T0 + 1.4 * D_
_pr = C.progress(_ch, _rows, now=_now)
assert str(_pr["pace_r"]) == "-0.0"
progress_cases.append({"json": _ch.to_json(), "rows": _rows, "now": _now, "progress": _pr,
                       "ru": C.progress_text(_ch, _pr, "ru"), "en": C.progress_text(_ch, _pr, "en"),
                       "ru_short": C.progress_text(_ch, _pr, "ru", short=True),
                       "en_short": C.progress_text(_ch, _pr, "en", short=True), "block_ru": None, "block_en": None})
out["progress"] = progress_cases

# ════════════════════════════════════════════════════════════════════════
# C. discipline
# ════════════════════════════════════════════════════════════════════════
disc = []
for _ in range(200):
    status = rng.choice([C.STATUS_ACTIVE] * 5 + [C.STATUS_DONE, C.STATUS_EXPIRED, C.STATUS_CANCELLED, "ACTIVE"])
    mtd = rng.choice([0, 1, 2, 3, 5, 100, rng.randint(0, 10)])
    risk = rng.choice([0.0, 0.1, 0.5, 1.0, 1.5, 2.0, 3.0, 10.0, round(rng.uniform(0.1, 10), 2), -1.0, 0.3])
    dlp = rng.choice([0.0, 0.5, 1.0, 2.0, 3.0, 5.0, 50.0, round(rng.uniform(0, 50), 2), -1.0, 0.7])
    ch = C.Challenge(user_id=1, started_at=T0, deposit=1000.0, goal_kind="pct", goal_value=10.0,
                     risk_pct=risk, max_trades_day=mtd, daily_loss_pct=dlp, status=status)
    lim = ch.daily_loss_r
    sig = rng.choice([0, 1, 2, 3, mtd, max(0, mtd - 1), mtd + 1, rng.randint(0, 10)])
    tr = rng.choice([0.0, -lim, -lim + 1e-9, -lim - 1e-9, -lim * 0.5, -lim * 2, rng.uniform(-10, 5),
                     round(rng.uniform(-10, 5), 2), 1.0, -0.0])
    b, reason = C.discipline(ch, sig, tr)
    disc.append({"status": status, "mtd": mtd, "risk": risk, "dlp": dlp, "sig": sig, "tr": tr,
                 "blocked": b, "reason": reason, "daily_loss_r": lim})
out["discipline"] = disc

# ════════════════════════════════════════════════════════════════════════
# D. gate on the real kv + trades
# ════════════════════════════════════════════════════════════════════════
gate_cases = []
for i in range(200):
    uid = 3000 + i
    started = T0 + rng.uniform(-3 * D_, 0)
    FAKE[0] = started
    ch = rand_challenge(uid, started)
    ch.max_trades_day = rng.choice([0, 1, 2, 3, 4])
    ch.risk_pct = rng.choice([0.5, 1.0, 2.0])
    ch.daily_loss_pct = rng.choice([0.0, 1.0, 2.0, 3.0])
    if rng.random() < 0.08:
        ch.status = rng.choice([C.STATUS_DONE, C.STATUS_CANCELLED])
    kind = rng.choice(["ok"] * 18 + ["none", "broken"])
    if kind == "ok":
        run(C.save(ch))
    elif kind == "broken":
        run(database.db_kv_set(C._key(uid), rng.choice(['{"user_id": %d}' % uid, "not json", "[]", '{"user_id": 1, "x": 2}'])))
    now = started + rng.choice([rng.uniform(0, 5 * D_), rng.uniform(0, H_), 3 * D_ - started % D_])
    mid = C._day_start(now)
    for _ in range(rng.randint(0, 9)):
        created = rng.choice([rng.uniform(max(mid, started), now), rng.uniform(started - D_, now + H_), mid, mid - 1e-6])
        r = rand_row(created, pure=False)
        if rng.random() < 0.6:
            r.update(result="", order_id="", progress_stage=rng.choice(["SL", "SL", "", "TP1", "BE", "MISSED"]))
        db_insert(uid, r)
    FAKE[0] = now + rng.choice([0.0, 1.5])
    CAP.take()
    g = run(C.gate(uid, now=now))
    gate_cases.append({"logs": CAP.take(), "uid": uid, "kind": kind, "kv": kv_snapshot(C._key(uid)).get(C._key(uid)), "now": now,
                       "wall": FAKE[0], "gate": g})
out["gate"] = gate_cases
_con.execute("DELETE FROM kv WHERE key LIKE 'challenge%'")   # the next sections start from an empty kv
_con.commit()

# ════════════════════════════════════════════════════════════════════════
# E. tick: 30 days, 10 challenges
# ════════════════════════════════════════════════════════════════════════
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


TS = T0 + 7 * H_ + 123.456
LANGS = {5001: "ru", 5002: "en", 5003: "de", 5004: "ru", 5005: "en", 5006: "ru", 5007: None, 5008: "ru",
         5009: "en", 5010: "", 5011: "en"}
FAIL_UM = {"on": False}


class FakeUM:
    async def get_or_create(self, uid, username=""):
        if uid == 5006 and FAIL_UM["on"]:
            raise RuntimeError("user lookup failed")
        return SimpleNamespace(user_id=uid, lang=LANGS.get(uid, "ru"))

    async def save(self, user):
        return None


BASE = {"deposit": 1000, "goal_kind": "pct", "goal_value": 25, "term": "1m", "risk_pct": 1, "leverage": 5,
        "max_trades_day": 3, "daily_loss_pct": 3, "topup_monthly": 0, "strategies": ["LEVELS"], "mode": "signals"}
TICK_USERS = {
    5001: (TS, dict(BASE, max_trades_day=2)),
    5002: (TS + 60.5, dict(BASE, term="2w", goal_value=10, risk_pct=2)),
    5003: (TS + 1800, dict(BASE, term="none", max_trades_day=0, daily_loss_pct=2)),
    5004: (TS, dict(BASE, term="2w", goal_value=1000)),
    5005: (TS + 7, dict(BASE, term="2w", goal_value=500)),
    5006: (TS + 99, dict(BASE, term="3m", max_trades_day=5)),
    5007: (TS + 5 * D_ + 3333.25, dict(BASE, term="1m", goal_value=40, max_trades_day=0, daily_loss_pct=0)),
    5008: (TS + 120, dict(BASE, term="1m", goal_value=300)),
    5009: (TS + 400, dict(BASE, term="none", goal_value=60, topup_monthly=200)),
    5010: (TS + 900, dict(BASE, goal_kind="usd", goal_value=1500, max_trades_day=1, risk_pct=0.5, daily_loss_pct=0.25)),
    5011: (TS + 2 * D_ + 0.75, dict(BASE, term="2w")),          # never a signal: expires without a card
}
STAGES_WIN = ["TP1", "TP2", "TP3"]
open_rows: dict = {}          # trade_id → uid
timeline = []
ticks = []
t = TS + 30
while t < TS + 30 * D_:
    ticks.append(t)
    t += rng.choice([600, 3600, 7200, 10800, 14400]) + rng.uniform(0, 60)
for d in range(31):
    day0 = C._day_start(TS) + d * D_
    ticks += [day0 + 20 * H_ - 0.0001, day0 + 20 * H_, day0 + 20 * H_ + 0.0000004, day0 + D_ - 0.0000004,
              day0 + D_ - 1e-7, day0 + D_ + 0.0000006]
ticks = sorted(t for t in ticks if TS + 30 <= t < TS + 30 * D_)
prev_kv: dict = {}
started_users: set = set()
prev_t = TS
for t in ticks:
    CAP.take()
    ops = []
    # start the challenges whose start time has come (5007 starts on day 5)
    for uid, (st0, a) in TICK_USERS.items():
        if uid not in started_users and st0 <= t:
            FAKE[0] = st0
            run(C.save(C.build(uid, a, now=st0)))
            started_users.add(uid)
            ops.append(["start", uid, st0, a])
    # new signals between the previous tick and this one
    for uid in TICK_USERS:
        if uid == 5011:
            continue
        n = 0
        span = t - prev_t
        while rng.random() < min(0.8, span / (6 * H_)) and n < 3:
            n += 1
            created = prev_t + rng.uniform(0, span)
            r = rand_row(created, pure=False)
            r.update(result="", order_id="", progress_stage="", signal_msg_id=rng.randint(1, 99),
                     result_rr=0.0, expire_rr=None)
            if uid == 5002:
                r.update(entry=100.0, sl=98.0, original_sl=98.0, tp1=102.0, tp2=104.0, tp3=106.0, direction="LONG")
            if rng.random() < 0.15:
                r.update(order_id=f"ex{_seq[0]}")
            tid = db_insert(uid, r)
            open_rows[tid] = uid
            ops.append(["insert", dict(DB_ROWS[-1])])
    # tracker progress on open rows
    for tid, uid in list(open_rows.items()):
        if rng.random() < 0.35:
            row = next(x for x in DB_ROWS if x["trade_id"] == tid)
            if row["order_id"]:
                res = rng.choice(["TP1", "SL", "BE", "MANUAL", "TP3"])
                f = {"result": res, "result_rr": {"TP1": 1.5, "SL": -1.0, "BE": 0.0, "MANUAL": round(rng.uniform(-1, 2), 2),
                                                   "TP3": 4.1}[res]}
            else:
                stage = rng.choice(STAGES_WIN + ["SL", "SL", "BE", "EXPIRED", "MISSED"])
                if uid == 5002:
                    stage = rng.choice(["TP3", "TP2", "SL"])
                if uid in (5001, 5003, 5010):
                    stage = rng.choice(["SL", "SL", "TP1", "BE"])
                f = {"progress_stage": stage}
                if stage == "EXPIRED":
                    f["expire_rr"] = round(rng.uniform(-1, 2), 2)
            db_update(tid, f)
            row.update(f)
            ops.append(["update", tid, f])
            if f.get("progress_stage") not in ("TP1", "TP2") or rng.random() < 0.5:
                open_rows.pop(tid)
    # external lifecycle events
    if not FAIL_UM["on"] and rng.random() < 0.05:
        FAIL_UM["on"] = True
    elif FAIL_UM["on"] and rng.random() < 0.2:
        FAIL_UM["on"] = False
    ops.append(["fail_um", FAIL_UM["on"]])
    if 5009 in started_users and rng.random() < 0.04:
        ch = run(C.load(5009))
        if ch is not None and ch.status == C.STATUS_ACTIVE:
            amt = rng.choice([100, 250.5, "75.125", 1.005])
            FAKE[0] = t - 5
            run(C.add_topup(ch, amt))
            ops.append(["topup", 5009, amt, t - 5])
    if 5008 in started_users and abs(t - (TS + 10 * D_)) < 4000:
        ch = run(C.load(5008))
        if ch is not None and ch.status == C.STATUS_ACTIVE:
            run(C.finish(ch, C.STATUS_CANCELLED, now=t - 1))
            ops.append(["finish", 5008, t - 1])
    wall = t + rng.choice([0.0, 0.0, 0.25, 2.0, 0.0, 0.0, 0.25, 2.0, 43200.0, -7200.5])
    FAKE[0] = wall
    SENT.clear()
    CARDS.clear()
    st = run(C.tick(FakeBot(), FakeUM(), now=t))
    kv_now = kv_snapshot()
    changed = {k: v for k, v in kv_now.items() if prev_kv.get(k) != v}
    prev_kv = kv_now
    gates = {}
    for uid in sorted(started_users):
        gates[uid] = run(C.gate(uid, now=t))
    timeline.append({"t": t, "wall": wall, "ops": ops, "stats": st, "sent": list(SENT), "cards": list(CARDS),
                     "kv": changed, "gates": gates, "logs": CAP.take()})
    prev_t = t
# a broken record aborts the whole pass (the loop logs it); removing it heals the next tick
FAKE[0] = TS + 30 * D_ + 10
run(database.db_kv_set("challenge_5999", '{"user_id": 5999, "deposit": 5}'))
try:
    run(C.tick(FakeBot(), FakeUM(), now=FAKE[0]))
    broken_tick = {"ok": True}
except Exception as e:  # noqa: BLE001
    broken_tick = err(e)
_con.execute("DELETE FROM kv WHERE key='challenge_5999'")
_con.commit()
final_lines = {}
for uid in sorted(TICK_USERS):
    ch = run(C.load(uid))
    rows = run(SS.signal_rows_since(uid, ch.started_at))
    lg = LANGS[uid] or "ru"
    final_lines[uid] = C.progress_text(ch, C.progress(ch, rows), lg, short=True) if ch.status == C.STATUS_ACTIVE else None
out["tick"] = {"langs": LANGS, "users": {u: [s, a] for u, (s, a) in TICK_USERS.items()}, "timeline": timeline,
               "broken_tick": broken_tick, "broken_wall": FAKE[0], "final_lines": final_lines,
               "final_kv": kv_snapshot()}
print("tick", len(timeline), "msgs", sum(len(e["sent"]) for e in timeline),
      "done", sum(e["stats"]["done"] for e in timeline), "expired", sum(e["stats"]["expired"] for e in timeline),
      "blocked", sum(e["stats"]["blocked"] for e in timeline), "daily", sum(e["stats"]["daily"] for e in timeline),
      "cards", sum(len(e["cards"]) for e in timeline), file=sys.stderr)

# ════════════════════════════════════════════════════════════════════════
# F. kv JSON round trips
# ════════════════════════════════════════════════════════════════════════
kvj = []
for i in range(100):
    started = T0 + rng.uniform(-1e6, 1e6)
    FAKE[0] = started
    ch = rand_challenge(7000 + i, started)
    start_json = ch.to_json()
    kops = []
    for _ in range(rng.randint(0, 5)):
        FAKE[0] += rng.uniform(1, 1e5)
        amt = rng.choice([1, 1.005, 2.675, "12.5", 10_000_000, rng.uniform(1, 1e6), "١٠"])
        try:
            run(C.add_topup(ch, amt))
            kops.append(["topup", amt, FAKE[0], True])
        except Exception:  # noqa: BLE001
            kops.append(["topup", amt, FAKE[0], False])
    for _ in range(rng.randint(0, 70) if rng.random() < 0.4 else rng.randint(0, 4)):
        FAKE[0] += rng.choice([0.0, rng.uniform(0, 3e4)])
        flag = rng.choice(["block:", "daily:"]) + C._day_key(FAKE[0] + rng.uniform(-9 * D_, 9 * D_))
        kops.append(["notify", flag, FAKE[0], run(C.notify_once(ch, flag))])
    if rng.random() < 0.3:
        fs, fnow = rng.choice([C.STATUS_DONE, C.STATUS_EXPIRED, C.STATUS_CANCELLED]), FAKE[0] + rng.uniform(0, 99)
        run(C.finish(ch, fs, now=fnow))
        kops.append(["finish", fs, fnow, True])
    good = ch.to_json()
    d = json.loads(good)
    raws = [good, rng.choice([json.dumps(d, indent=2), json.dumps(dict(reversed(list(d.items())))),
                              json.dumps(d, separators=(",", ":"))])]
    d2 = dict(d)
    for k in rng.sample(list(d2), rng.randint(0, 6)):
        if k not in ("user_id", "started_at", "deposit", "goal_kind", "goal_value"):
            d2.pop(k)
    d2["zz_extra"] = rng.choice([1, "x", None, [1, 2]])
    raws.append(json.dumps(d2))
    if rng.random() < 0.2:
        d3 = dict(d)
        d3.pop(rng.choice(["started_at", "deposit", "goal_kind", "goal_value"]))
        raws.append(json.dumps(d3))
    if rng.random() < 0.2:
        d4 = dict(d, status=rng.choice(["актив", "a\U00002028b", "\x7f", "é\"\\", "é\U00000301", "\U0001f600"]),
                  mode=rng.choice(["auto", "автотрейд"]))
        raws.append(json.dumps(d4, ensure_ascii=rng.choice([True, False])))
    res = []
    for raw in raws:
        try:
            c2 = C.Challenge.from_json(raw)
            res.append({"raw": raw, "ok": True, "json": c2.to_json() if c2 is not None else None})
        except Exception as e:  # noqa: BLE001
            res.append(dict(err(e), raw=raw))
    kvj.append({"start": start_json, "ops": kops, "good": good, "derived": {"goal_usd": ch.goal_usd, "goal_profit_usd": ch.goal_profit_usd,
                                          "risk_usd": ch.risk_usd, "r_needed": ch.r_needed,
                                          "topups_total": ch.topups_total, "daily_loss_r": ch.daily_loss_r},
                "dict": M._challenge_dict(ch), "raws": res})
out["kv_json"] = kvj
# add_topup on hostile amounts
topups = []
for _ in range(80):
    ch = rand_challenge(7999, T0)
    start_json = ch.to_json()
    amt = rng.choice([adv_value(), rng.uniform(0, 2e7), rng.choice(WEIRD)])
    FAKE[0] = T0 + rng.uniform(0, 1e5)
    try:
        run(C.add_topup(ch, amt))
        topups.append({"start": start_json, "amount": amt, "wall": FAKE[0], "ok": True, "json": ch.to_json(),
                       "total": ch.topups_total})
    except Exception as e:  # noqa: BLE001
        topups.append(dict(err(e), start=start_json, amount=amt, wall=FAKE[0]))
out["topup"] = topups

# ════════════════════════════════════════════════════════════════════════
# G. entry advisor
# ════════════════════════════════════════════════════════════════════════
env_cases = []
KEYS_ENV = ("ENABLED", "DAYS", "MIN_MISSED", "MIN_SHARE", "REPEAT_DAYS", "INTERVAL_S")
ENV_VALS = ["", " ", "0", "1", "2", "-3", "7", "14", "abc", " 21 ", "1e4", "0.3", "0.01", "0.95", "nan", "inf",
            "1_0", "١٤", "\xa014", "false", "FALSE", "off", "Off", " 0 ", "True", "14.0", "600", "10", "9" * 30]
for _ in range(40):
    env = {}
    for k in KEYS_ENV:
        if rng.random() < 0.35:
            env["ENTRY_ADVISOR_" + k] = rng.choice(ENV_VALS)
    saved = {k: os.environ.pop(k) for k in list(os.environ) if k.startswith("ENTRY_ADVISOR_")}
    os.environ.update(env)
    try:
        importlib.reload(EA)
        env_cases.append({"env": env, "ok": True, "cfg": {k: getattr(EA, k) for k in KEYS_ENV}})
    except Exception as e:  # noqa: BLE001
        env_cases.append(dict(err(e), env=env))
    for k in env:
        os.environ.pop(k, None)
    os.environ.update(saved)
importlib.reload(EA)
out["advisor_env"] = env_cases

FAKE[0] = T0 + 50 * D_ + 777.125
ADV_NOW = FAKE[0]
cut = FAKE[0] - EA.DAYS * 86400
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


_orig_kv_get, _orig_kv_set = database.db_kv_get, database.db_kv_set
database.db_kv_get = kv_get
database.db_kv_set = kv_set
import telegram_safe  # noqa: E402


async def fake_safe_send(bot, uid, text, **kw):
    rm = kw.get("reply_markup")
    ADV_SENT.append({"uid": uid, "text": text, "disable_notification": kw.get("disable_notification"),
                     "buttons": [[b.text, b.callback_data] for row in rm.inline_keyboard for b in row] if rm else None})
    return SEND_OK[0]


telegram_safe.safe_send_message = fake_safe_send
adv = []
for i in range(50):
    uid = 2000 + i
    profile = rng.choice(["levels", "smc", "mixed", "few", "lowshare", "random"])
    for _ in range(rng.randint(0, 45)):
        created = rng.choice([cut + rng.uniform(0, EA.DAYS * D_), cut - rng.uniform(0, 10 * D_), cut, cut - 1e-6,
                              FAKE[0] + rng.uniform(0, H_)])
        strat = {"levels": "LEVELS", "smc": rng.choice(["SMC", "smc"])}.get(
            profile, rng.choice(["LEVELS", "SMC", "VOLUME", "smc", "", None, "GERCHIK", "volume", " SMC"]))
        stage = rng.choice(["MISSED", "MISSED", "missed", "", None, "TP1", "SL", "Missed", "MISSED "])
        if profile in ("levels", "smc"):
            stage = rng.choice(["MISSED", "MISSED", "TP1", "SL"])
        if profile == "lowshare":
            stage = rng.choice(["MISSED", "TP1", "SL", "", "BE", "TP2"])
        msg = rng.choice([0, None, 5, 6, 7, -1, 1]) if profile in ("random", "few") else rng.choice([5, 7, 9, 0])
        r = {"symbol": "BTC-USDT-SWAP", "direction": "LONG", "entry": 1.0, "sl": 0.98, "tp1": 1.02, "tp2": 1.04,
             "tp3": 1.06, "created_at": created, "strategy": strat, "progress_stage": stage, "signal_msg_id": msg}
        if strat is None:
            r.pop("strategy")
        if stage is None:
            r.pop("progress_stage")
        if msg is None:
            r.pop("signal_msg_id")
        db_insert(uid, r)
    wall = ADV_NOW + rng.choice([0.0, 0.0, 0.0, 3 * D_, -2 * D_, 0.5])
    FAKE[0] = wall
    ms = run(EA.missed_stats(uid))
    pick = EA.pick_advice(ms)
    attrs = {}
    if rng.random() < 0.15:
        attrs["prefer_market_entry"] = True
    attrs["lang"] = rng.choice(["ru", "en", "de", "", "ru", "en"])
    if rng.random() < 0.3:
        attrs["quiet_start"], attrs["quiet_end"] = rng.choice([(0, 23), (22, 1), (5, 6), (-1, -1), (23, 23), (1, 0)])
    kv0 = rng.choice([None, None, str(int(ADV_NOW - 6 * D_)), str(int(ADV_NOW - 7 * D_)), str(int(ADV_NOW - 8 * D_)),
                      "garbage", "RAISE", f"{ADV_NOW - 7 * D_ + 0.5:.3f}", "nan", "inf", "-inf", "", "1e3", " 12 ",
                      "\U00000661\U00000662", "\xa0" + str(int(ADV_NOW - 9 * D_))])
    ADV_KV.clear()
    ADV_SENT.clear()
    if kv0 is not None:
        ADV_KV[f"{EA.KV_PREFIX}{uid}"] = kv0
    SEND_OK[0] = rng.random() < 0.85
    u = UserSettings(user_id=uid)
    for k, v in attrs.items():
        setattr(u, k, v)
    CAP.take()
    ret = run(EA.advise_user(None, u, now=ADV_NOW))
    adv.append({"logs": CAP.take(), "uid": uid, "wall": wall, "missed": ms, "pick": pick, "attrs": attrs, "kv0": kv0, "send_ok": SEND_OK[0], "ret": ret,
                "sent": list(ADV_SENT), "kv": dict(ADV_KV)})
out["advisor"] = {"now": ADV_NOW, "cases": adv}
pick_cases = []
for _ in range(100):
    st = {}
    for s in rng.sample(["LEVELS", "SMC", "VOLUME", "X"], rng.randint(0, 4)):
        st[s] = {"missed": rng.choice([0, 1, 4, 5, 6, 9, 10, 30, rng.randint(0, 40)]),
                 "total": rng.choice([0, 1, 5, 10, 15, 16, 17, 20, 30, 100, rng.randint(0, 60)])}
        if rng.random() < 0.05:
            st[s].pop(rng.choice(["missed", "total"]))
    pick_cases.append([st, EA.pick_advice(st)])
out["advisor_pick"] = pick_cases
texts = []
for _ in range(60):
    s = rng.choice(["LEVELS", "SMC", "VOLUME", "X<&>\"'", "Gerchik"])
    m, tt = rng.randint(0, 40), rng.randint(0, 60)
    lg = rng.choice(["ru", "en", "de", ""])
    texts.append([s, m, tt, lg, EA.advice_text(s, m, tt, lg)])
out["advisor_text"] = texts
database.db_kv_get, database.db_kv_set = _orig_kv_get, _orig_kv_set

# ════════════════════════════════════════════════════════════════════════
# H. questionnaire helpers
# ════════════════════════════════════════════════════════════════════════
pn = []
for _ in range(150):
    parts = [rng.choice(["", " ", "$", "€", "≈", "x", "-", "+", "abc", "\U000000a0", "1", "25", "2 500", "3,5", "7.25",
                         "١٢", "٣٫٥", "\U00016d71", "\U0001ccf3", "１２", ",", ".", "..", "1.", ".5", "1,2,3", "%", "\n"])
             for _ in range(rng.randint(0, 6))]
    s = "".join(parts)
    try:
        pn.append([s, True, H._parse_num(s)])
    except Exception as e:  # noqa: BLE001
        pn.append([s, False, err(e)])
out["parse_num"] = pn
ans = []
for _ in range(80):
    stt = {}
    for k in ("goal", "deposit", "term", "risk", "leverage", "trades", "loss", "topup", "strategies", "mode"):
        if rng.random() < 0.6:
            if k == "goal":
                stt[k] = rng.choice(["pct:10", "usd:2500.0", "pct:abc", "x", "", "usd:12:3", "pct: 5 ", "usd:١٠٠", ":5",
                                     "pct:", None])
            elif k == "strategies":
                stt[k] = rng.choice([[], ["SMC"], None, ["LEVELS", "VOLUME"]])
            else:
                stt[k] = rng.choice([None, 0, 1.5, "x", 5, 100.0, "2w"])
    try:
        ans.append({"state": stt, "ok": True, "answers": H._answers(stt)})
    except Exception as e:  # noqa: BLE001
        ans.append(dict(err(e), state=stt))
out["answers_from_state"] = ans

# ════════════════════════════════════════════════════════════════════════
# I. Mini App routes
# ════════════════════════════════════════════════════════════════════════
M._RATE.clear()
USER_FIELDS = ("trade_risk_pct", "trade_leverage", "auto_trade", "strategy", "extra_strategies", "long_active",
               "short_active", "smc_long_active", "smc_short_active", "vol_long_active", "vol_short_active",
               "active", "scan_mode", "prefer_market_entry")
ROUTE_T0 = T0 + 60 * D_


def mk_user(uid, plan):
    u = UserSettings(user_id=uid)
    u.sub_plan = plan
    u.sub_status = "active"
    u.sub_expires = ROUTE_T0 + 300 * D_
    return u


ROUTE_USERS = {8001: mk_user(8001, "pro"), 8002: mk_user(8002, "pro"), 8003: mk_user(8003, "free"),
               123: mk_user(123, "free"), 8004: mk_user(8004, "pro")}
ROUTE_USERS[8002].bingx_api_key, ROUTE_USERS[8002].bingx_api_secret = "k" * 12, "s" * 12
ROUTE_INIT = {uid: {k: getattr(u, k) for k in USER_FIELDS} for uid, u in ROUTE_USERS.items()}
CUR = {"uid": 8001}


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
        return self._body


HANDLERS = {"GET challenge": M.h_challenge_get, "POST challenge": M.h_challenge_post,
            "POST challenge/topup": M.h_challenge_topup, "POST challenge/finish": M.h_challenge_finish}
for uid in (8001, 8002, 8004):
    for _ in range(rng.randint(5, 25)):
        db_insert(uid, rand_row(ROUTE_T0 - rng.uniform(0, 35) * D_, pure=False))
for uid in ROUTE_USERS:
    UIDS.add(uid)
FLAGS = [True, False, 0, 1, "", "0", "false", [], {}, None, [0], "yes"]
steps = []
clock = ROUTE_T0
for i in range(220):
    clock += rng.choice([0.25, 1, 3, 5, 15, 60, 61, 300, 3600, 2 * D_])
    uid = rng.choice([8001, 8001, 8002, 8002, 8004, 8003, 123])
    route = rng.choice(["GET challenge"] * 3 + ["POST challenge"] * 4 + ["POST challenge/topup"] * 2 + ["POST challenge/finish"])
    if route == "GET challenge" and rng.random() < 0.3:
        burst = rng.randint(3, 12)
    else:
        burst = 1
    for b in range(burst):
        body = None
        if route == "POST challenge":
            body = rand_answers(rng.choice([0.97, 0.97, 0.7]))
            if rng.random() < 0.5:
                body["preview"] = rng.choice(FLAGS)
            if rng.random() < 0.4:
                body["replace"] = rng.choice(FLAGS)
            if rng.random() < 0.1:
                body["junk"] = {"x": 1}
            if rng.random() < 0.05:
                body = rng.choice([[1, 2], ["deposit"]])
        elif route == "POST challenge/topup":
            body = rng.choice([{"amount": adv_value()}, {"amount": rng.uniform(0, 2e4)}, {}, {"amount": rng.choice(WEIRD)},
                               {"amount": rng.choice([1, 5, 250.555, "100", 0.99, 1e7, 1e7 + 1])}])
        elif route == "POST challenge/finish":
            body = rng.choice([None, {}, {"x": 1}])
        clock += 0.05
        FAKE[0] = clock
        CUR["uid"] = uid
        method = route.split(" ")[0]
        CAP.take()
        try:
            resp = run(HANDLERS[route](Req(method, body)))
            status, payload = resp.status, json.loads(resp.body)
        except web.HTTPException as e:
            status, payload = e.status, json.loads(e.text)
        steps.append({"logs": CAP.take(), "uid": uid, "route": route, "body": body, "now": clock, "status": status, "json": payload,
                      "kv": kv_snapshot(C._key(uid)).get(C._key(uid)),
                      "user": {k: getattr(ROUTE_USERS[uid], k) for k in USER_FIELDS}})
out["routes"] = {"init": ROUTE_INIT, "plans": {u: x.sub_plan for u, x in ROUTE_USERS.items()},
                 "keys": {"8002": ["bingx", "k" * 12, "s" * 12]}, "expires": ROUTE_T0 + 300 * D_, "steps": steps}
print("routes", len(steps), "statuses", sorted({(s["status"], s["json"].get("error")) for s in steps}, key=str), file=sys.stderr)

def _sanitize(x):
    """Non-finite floats → {"$f": "inf" | "-inf" | "nan"} (JSON has no literal for them)."""
    if isinstance(x, float) and x != x:
        return {"$f": "nan"}
    if isinstance(x, float) and x in (float("inf"), float("-inf")):
        return {"$f": "inf" if x > 0 else "-inf"}
    if isinstance(x, dict):
        return {k: _sanitize(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_sanitize(v) for v in x]
    return x


# ════════════════════════════════════════════════════════════════════════
# J. module constants from the environment (challenge.py, db/signal_outcome.py)
# ════════════════════════════════════════════════════════════════════════
import db.signal_outcome as SO  # noqa: E402
cenv = []
CENV_VALS = ["", " ", "0", "59", "60", "61.5", "600", "-5", "abc", "1e3", "nan", "inf", "-inf", "1_200", "\U00000661\U00000662",
             "\xa030\xa0", "\U0000feff30", "\x1c30", "24", "23", "-1", "7.5", "20", "9" * 40, "  21  ", "0x10", "1" * 4301]
for _ in range(60):
    env = {}
    for k in ("CHALLENGE_LOOP_INTERVAL_S", "CHALLENGE_DAILY_HOUR_UTC", "SIGNAL_TRACKER_MAX_AGE_H"):
        if rng.random() < 0.5:
            env[k] = rng.choice(CENV_VALS)
    for k in ("CHALLENGE_LOOP_INTERVAL_S", "CHALLENGE_DAILY_HOUR_UTC", "SIGNAL_TRACKER_MAX_AGE_H"):
        os.environ.pop(k, None)
    os.environ.update(env)
    rec = {"env": env}
    try:
        importlib.reload(C)
        rec.update(ok=True, cfg={"LOOP_INTERVAL_S": C.LOOP_INTERVAL_S, "DAILY_HOUR_UTC": C.DAILY_HOUR_UTC})
    except Exception as e:  # noqa: BLE001
        rec.update(err(e))
    importlib.reload(SO)
    rec["max_age_s"] = SO.MAX_AGE_S
    cenv.append(rec)
    for k in env:
        os.environ.pop(k, None)
importlib.reload(C)
importlib.reload(SO)
out["challenge_env"] = cenv

out["db_rows"] = [r for r in DB_ROWS if r["user_id"] not in TICK_USERS]   # tick rows travel in its ops
out["uids"] = sorted(UIDS | set(TICK_USERS))
_text = json.dumps(_sanitize(out), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
# UTF-8 cannot carry the lone surrogates of the hostile strings: those stay JSON escapes
_text = re.sub("[" + chr(0xd800) + "-" + chr(0xdfff) + "]", lambda m: "\\u%04x" % ord(m.group()), _text)
if OUT.endswith(".gz"):                   # the committed fixture is gzipped (like tests/golden/expected)
    import gzip
    with gzip.open(OUT, "wb", compresslevel=9) as f:
        f.write(_text.encode("utf-8"))
else:
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(_text)
print("wrote", OUT, "db rows", len(DB_ROWS), file=sys.stderr)
os._exit(0)
