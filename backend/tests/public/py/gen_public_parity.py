"""PY311 parity vectors for the bot-derived parts of GET /api/public/{trend,feed,stats}.

The public endpoints have no counterpart in the bot; what they take from it is computed by the
bot's own code here:

  trend  trend_monitor.load_state() over a kv `trend_state_v1` value (database.db_kv_get patched),
         _strength[tf] = ribbon_strength(df(close), state trend) for the bars of the case, get_all()
  rows   db.signal_outcome.signal_status / signal_rr on the tracker view of a trade
         ({**t, result: "", result_rr: None, skip_reason: "", progress_stage: stage,
           expire_rr: t.expire_rr if stage == EXPIRED else None}), plus the card outcome R of
         signal_tracker.update_signal_card (signal_rr({**t, progress_stage: stage, result: ""},
         stage.lower())) to show the two views agree on every tracker stage.

Run from the bot checkout (read-only), CPython 3.11:
  cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && PYTHONDONTWRITEBYTECODE=1 BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \
    <venv311>/bin/python <site>/backend/tests/public/py/gen_public_parity.py <site>/backend/tests/public/fixtures/public_parity.json
  rm -f signal_registry.json
"""

import asyncio
import json
import math
import os
import random
import sys
import platform

sys.path.insert(0, os.getcwd())   # the bot checkout

import pandas as pd  # noqa: E402

import database
import trend_monitor as tm
from db.signal_outcome import signal_status, signal_rr

OUT = sys.argv[1]
T0 = 1_760_000_000.0


def closes(n, drift, phase):
    return [round(100 + drift * i + 3 * math.sin(i / 7 + phase) + math.sin(i / 2.3 + phase / 3), 6) for i in range(n)]


def run_trend(raw, bars):
    tm._state.clear()
    tm._strength.clear()
    tm._loaded = False

    async def kv_get(key):
        assert key == tm.KV_KEY
        return raw

    database.db_kv_get = kv_get
    asyncio.run(tm.load_state())
    for tf in list(tm._state):
        c = bars.get(tf)
        df = pd.DataFrame({"close": c}) if c is not None else None
        s = tm.ribbon_strength(df, tm._state[tf]["trend"])
        if s is not None:
            tm._strength[tf] = s
    out = {}
    for tf, st in tm.get_all().items():
        out[tf] = {"trend": st["trend"], "since": st["since"], "ema": st["ema"], "strength": st.get("strength")}
    return out


def trend_cases():
    full = {
        "15m": {"trend": "LONG", "since": T0 - 3 * 3600, "price": 121000.5},
        "1H": {"trend": "LONG", "since": T0 - 11 * 3600, "price": 120000.0},
        "4H": {"trend": "RANGE", "since": T0 - 50 * 3600, "price": 118000.0},
        "1D": {"trend": "LONG", "since": T0 - 9 * 86400, "price": 110000.0},
        "1W": {"trend": "SHORT", "since": T0 - 20 * 86400, "price": 105000.0},
        "1M": {"trend": "LONG", "since": 0, "price": 90000.0},
    }
    sets = {
        "base": {"15m": closes(300, 0.08, 0), "1H": closes(300, 0.02, 1), "4H": closes(300, -0.01, 2),
                 "1D": closes(300, 0.3, 3), "1W": closes(300, -0.2, 4), "1M": closes(80, 0.5, 5)},
        "flat": {tf: closes(300, 0.0, i) for i, tf in enumerate(tm.TFS)},
        "down": {tf: closes(300, -0.15, i) for i, tf in enumerate(tm.TFS)},
        "short": {"15m": closes(300, 0.08, 0), "1H": closes(300, 0.02, 1), "4H": closes(300, -0.01, 2),
                  "1D": closes(40, 0.1, 0), "1W": closes(300, -0.2, 4)},
    }
    bars = "base"
    cases = [
        ("full", json.dumps(full), "base"),
        ("flat bars", json.dumps(full), "flat"),
        ("falling bars", json.dumps({tf: {**v, "trend": "SHORT"} for tf, v in full.items()}), "down"),
        ("short history: 1D 40 bars, no 1M bars", json.dumps(full), "short"),
        ("since as string, price missing, trend not a string", json.dumps({
            "15m": {"trend": "SHORT", "since": "1759990000.5"}, "1H": {"trend": 5, "since": T0}, "4H": {"trend": "LONG", "since": None, "price": None},
        }), bars),
        ("unknown TF and an empty trend are skipped", json.dumps({**full, "5m": {"trend": "LONG"}, "1D": {"trend": ""}}), bars),
        ("NaN price round-trips", '{"15m": {"trend": "LONG", "since": 1759990000, "price": NaN}, "1H": {"trend": "SHORT", "since": 1759980000, "price": 1}, "4H": {"trend": "RANGE", "since": 1759970000, "price": 2}}', bars),
        ("a malformed since stops the load (one try block)", '{"15m": {"trend": "LONG", "since": 1759990000}, "1H": {"trend": "LONG", "since": "abc"}, "4H": {"trend": "LONG", "since": 1}}', bars),
        ("missing 4H", json.dumps({k: v for k, v in full.items() if k != "4H"}), bars),
        ("not a dict", "[1, 2, 3]", bars),
        ("invalid JSON", "{nope", bars),
        ("no kv", None, bars),
    ]
    out = []
    for name, raw, b in cases:
        out.append({"name": name, "raw": raw, "bars": b, "py": run_trend(raw, sets[b])})
    return sets, out


def rows():
    rnd = random.Random(20261009)
    v = T0 + 100 * 3600
    stages = ["", "ENTRY", "TP1", "TP2", "TP3", "SL", "BE", "EXPIRED", "MISSED"]
    out = []
    for i in range(300):
        direction = rnd.choice(["LONG", "SHORT"])
        entry = round(rnd.uniform(0.5, 70000), rnd.choice([2, 4, 6]))
        risk = entry * rnd.choice([0.002, 0.01, 0.02, 0.05])
        sgn = 1 if direction == "LONG" else -1
        sl = entry - sgn * risk
        row = {
            "trade_id": f"7_{i}", "user_id": 7, "direction": direction, "entry": entry, "sl": sl,
            "original_sl": rnd.choice([None, 0, sl, entry - sgn * risk * 1.5]),
            "tp1": rnd.choice([0, entry + sgn * risk * 1.2]), "tp2": entry + sgn * risk * 2.1, "tp3": rnd.choice([0, entry + sgn * risk * 3.3]),
            "created_at": v - rnd.choice([3600, 50 * 3600, 71.9 * 3600, 72.1 * 3600, 90 * 3600]),
            "progress_stage": rnd.choice(stages), "progress_ts": 0,
            "expire_rr": rnd.choice([None, 0.734, -1.0, "0.5", "abc", 2.675, ""]),
            "result": rnd.choice(["", "", "", "TP3", "SKIP", "MANUAL", "SL", "BE"]),
            "result_rr": rnd.choice([None, 4.0, -1.0, ""]),
            "skip_reason": rnd.choice(["", "manual", "ghost"]),
            "signal_msg_id": rnd.choice([1, 77]), "order_id": "",
        }
        stage = row["progress_stage"]
        view = {**row, "result": "", "result_rr": None, "skip_reason": "", "progress_stage": stage,
                "expire_rr": row["expire_rr"] if stage == "EXPIRED" else None}
        st = signal_status(view, v)
        rr = signal_rr(view, st)
        card = None
        if stage in ("TP1", "TP2", "TP3", "SL", "BE", "EXPIRED"):
            card = signal_rr({**row, "progress_stage": stage, "result": ""}, stage.lower())
            # the card view keeps result_rr / skip_reason; result "" makes them inert
            assert st == stage.lower(), (st, stage)
            assert card == rr, (card, rr, row)
        out.append({"row": row, "v": v, "py": {"status": st, "rr": rr, "card_rr": card}})
    return out


def main():
    data = {
        "note": "generated by gen_public_parity.py with the bot's own trend_monitor / db.signal_outcome (see docstring)",
        "python": platform.python_version(), "pandas": pd.__version__,
    }
    data["bars"], data["trend"] = trend_cases()
    data["rows"] = rows()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print("wrote", OUT, len(data["trend"]), "trend cases", len(data["rows"]), "rows")


if __name__ == "__main__":
    main()
