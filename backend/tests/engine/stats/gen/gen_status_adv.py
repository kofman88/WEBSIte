"""gen_status_adv.py — 300 random signal_trades-shaped rows (legacy rows with missing
columns, ghost SKIP / ORPHAN / manual SKIP, exchange rows, string / NaN / negative values,
lowercase results and stages, the 72 h boundary) through the bot's db/signal_outcome.py:
signal_status, signal_rr for the real status and for every status, has_card,
is_exchange_trade. For backend/tests/engine/stats/statusAdv.test.js.

  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python gen_status_adv.py /abs/status_adv.json
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

from db import signal_outcome as so  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else "status_adv.json"
rng = random.Random(30030)
NOW = 1_766_000_000.0
STATUSES = ("tp1", "tp2", "tp3", "sl", "be", "missed", "expired", "open", "closed", "skip", "", "x")


def enc(v):
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return {"$f": "nan" if math.isnan(v) else ("inf" if v > 0 else "-inf")}
    if isinstance(v, dict):
        return {k: enc(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [enc(x) for x in v]
    return v


def pick(choices):
    return rng.choice(choices)


RES = ["", "", "TP1", "TP2", "TP3", "SL", "BE", "MANUAL", "TRAIL", "SKIP", "SKIP", "SKIP", "ORPHAN",
       "tp2", "sl", "skip", "orphan", "manual", "CLOSED", "OPEN", "x", None, 0, " TP1", "TP1 "]
STG = ["", "", "", "ENTRY", "TP1", "TP2", "TP3", "SL", "BE", "EXPIRED", "MISSED", "tp3", "be", "expired",
       "missed", None, 0, "XX", " SL"]
NUM = [None, "", 0, 0.0, -0.0, 1.5, -1.0, "2.5", "x", "nan", "inf", 3, "1_0", " 0.75 ", True, float("nan")]
MSG = [0, 0, 5, 77, None, "7", "x", -1, 1.5, "1.5", "0", " 9 ", True, False, 0.4, float("nan"), "1_2"]
OID = ["", "", "o1", None, "  ", "123", 0, 5, "\t"]

rows = []
for k in range(300):
    r = {}
    kind = rng.random()
    if kind < 0.1:                         # legacy: almost nothing
        for key in ("result", "created_at"):
            if rng.random() < 0.5:
                r[key] = pick(RES) if key == "result" else pick([NOW - 10, None, 0])
        rows.append(r)
        continue
    if rng.random() < 0.9:
        r["result"] = pick(RES)
    if rng.random() < 0.85:
        r["progress_stage"] = pick(STG)
    if rng.random() < 0.5:
        r["skip_reason"] = pick(["", "manual", "ghost", None, "not_delivered", "MANUAL", 0, "manual "])
    if rng.random() < 0.8:
        r["signal_msg_id"] = pick(MSG)
    if rng.random() < 0.75:
        r["order_id"] = pick(OID)
    r["created_at"] = pick([NOW - rng.uniform(0, 100) * 3600, NOW - so.MAX_AGE_S, NOW - so.MAX_AGE_S - 0.001,
                            0, None, NOW + 5, "abc", str(NOW - 80 * 3600), "", float("nan")])
    if rng.random() < 0.6:
        r["result_rr"] = pick(NUM + [rng.uniform(-1, 4)])
    if rng.random() < 0.5:
        r["expire_rr"] = pick(NUM + [0.555, -0.125, 0.005, 0.015, 1.005, 2.675, rng.uniform(-1, 3)])
    d = pick(["LONG", "SHORT"])
    s = 1 if d == "LONG" else -1
    e = pick([100.0, 0.01234, 65432.1, 2.5])
    risk = e * rng.uniform(0.004, 0.03)
    r.update({"direction": d, "entry": e, "sl": e - s * risk, "tp1": e + s * risk * rng.uniform(1, 2),
              "tp2": e + s * risk * rng.uniform(2, 3.5), "tp3": e + s * risk * rng.uniform(3.5, 6)})
    if rng.random() < 0.35:
        r["original_sl"] = pick([None, 0, "", e - s * risk * 1.2, e - s * risk * 0.8, "nan", "x", -5.0])
    if rng.random() < 0.15:
        r["sl"] = e                        # moved to break-even
    if rng.random() < 0.1:
        r[pick(["entry", "sl", "tp1", "tp2", "tp3"])] = pick(NUM)
    rows.append(r)

out = {"now": NOW, "max_age_s": so.MAX_AGE_S, "rows": []}
for r in rows:
    st = so.signal_status(r, NOW)
    out["rows"].append({"row": r, "status": st, "rr": so.signal_rr(r, st),
                        "rr_by": {s: so.signal_rr(r, s) for s in STATUSES},
                        "has_card": so.has_card(r), "exchange": so.is_exchange_trade(r),
                        "status_now": [so.signal_status(r, n) for n in (0.0, NOW + 3 * 86400)]})
json.dump(enc(out), open(OUT, "w"), ensure_ascii=False)
from collections import Counter  # noqa: E402
print(len(rows), Counter(x["status"] for x in out["rows"]))
