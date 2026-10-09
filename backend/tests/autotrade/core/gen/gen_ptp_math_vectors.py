"""gen_ptp_math_vectors.py — CPython 3.11 reference for the pure partial-TP helpers (PLAN M13
"calculate_partial_tp_*" + AUDIT-FIX-C74 BU helpers), replayed by ptpMath.test.js against
services/autotrade/partialTp.js:

  calculate_partial_tp_prices(entry, sl, direction, tp1_r, tp2_r)   round(entry ± risk·r, 8)
  calculate_partial_tp_qty(total_qty, tp1_pct, tp2_pct)             + the [PTP-PCT-CLAMP] warning
  bu_target_price(entry, direction, fee_pct)
  should_apply_bu_after_partial(initial_qty, pos_size_now, current_sl, entry, direction,
                                be_already_set, threshold, mark_price, sl_dist, min_progression_r)

Edge cases (zero / negative risk, sum of pcts > 100, every direction spelling, progression gate
on/off, thresholds) plus seeded random cases over price scales from 1e-8 (1000x coins) to 1e5.
Non-finite floats are written as {"f": "inf" | "-inf" | "nan"} (JSON has no literal for them).

Output: backend/tests/autotrade/core/fixtures/ptp_math_vectors.json
  cd /home/user/MAIN_BOT/CHM_BREAKER_V4
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 $PY311 -I -B <worktree>/backend/tests/autotrade/core/gen/gen_ptp_math_vectors.py
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import json
import logging
import math
import os
import random
import sys

assert sys.version_info[:2] == (3, 11), sys.version
sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "fixtures", "ptp_math_vectors.json"))
sys.path.insert(0, os.getcwd())

import partial_tp  # noqa: E402  (the bot's own module, cwd = bot tree)

LOGS: list = []


class _Cap(logging.Handler):
    def emit(self, r):
        LOGS.append([r.levelname, r.getMessage()])


partial_tp.log.addHandler(_Cap())
partial_tp.log.setLevel(logging.DEBUG)
partial_tp.log.propagate = False


def enc(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, float) and not math.isfinite(v):
        return {"f": "nan" if math.isnan(v) else ("inf" if v > 0 else "-inf")}
    if isinstance(v, (list, tuple)):
        return [enc(x) for x in v]
    return v


def run(fn, args):
    LOGS.clear()
    try:
        out = {"ret": enc(fn(*args))}
    except Exception as e:  # noqa: BLE001
        out = {"raise": [type(e).__name__, str(e)]}
    out["logs"] = list(LOGS)
    return out


DIRS = ["LONG", "SHORT", "long", "short", "Long", "sHoRt", "", "BUY", "SELL", "x", " long", "long "]
R = random.Random(1311)


def rnd_price():
    scale = 10 ** R.uniform(-8, 5)
    return round(scale * R.uniform(0.5, 2.0), R.choice([2, 4, 6, 8, 10, 12]))


def main():
    prices, qtys, bus, shoulds = [], [], [], []

    # ── calculate_partial_tp_prices ────────────────────────────────────────
    fixed = [
        (100.0, 98.0, "LONG", 1.0, 1.5), (100.0, 102.0, "SHORT", 1.0, 1.5),
        (100.0, 100.0, "LONG", 1.0, 1.5), (100.0, 102.0, "LONG", 1.0, 1.5),
        (100.0, 98.0, "SHORT", 1.0, 1.5), (0.1234567891, 0.1200000001, "long", 1.5, 2.0),
        (0.00001234, 0.00001200, "LONG", 1.0, 1.5), (65432.1, 64000.0, "short", 0.0, 0.0),
        (1.0, 0.9, "x", 1.0, 1.5), (1.0, 0.9, "", 2.5, 3.5), (2.0, 1.0, "LONG", -1.0, 1.5),
        (3e-9, 1e-9, "LONG", 1.0, 1.5), (1e5, 9.9e4, "SHORT", 10.0, 20.0),
        (0.1, 0.3, "LONG", 1.0, 1.5), (0.3, 0.1, "SHORT", 1.0, 1.5),
        (100.0, float("nan"), "LONG", 1.0, 1.5), (100.0, float("inf"), "LONG", 1.0, 1.5),
        (1.005, 1.0, "LONG", 1.0, 1.0), (2.675, 2.665, "LONG", 1.0, 1.5),
    ]
    for a in fixed:
        prices.append({"args": enc(list(a)), **run(partial_tp.calculate_partial_tp_prices, a)})
    for _ in range(400):
        e = rnd_price()
        s = round(e * (1 + R.choice([-1, 1]) * R.uniform(0.0005, 0.08)), R.choice([4, 8, 12]))
        a = (e, s, R.choice(DIRS), R.choice([1.0, 1.5, 2.0, 0.5, 3.0, R.uniform(0.1, 5)]),
             R.choice([1.5, 2.0, 2.5, R.uniform(0.1, 6)]))
        prices.append({"args": enc(list(a)), **run(partial_tp.calculate_partial_tp_prices, a)})

    # ── calculate_partial_tp_qty ───────────────────────────────────────────
    fixed_q = [
        (100.0, 40.0, 30.0), (100.0, 50.0, 50.0), (100.0, 60.0, 50.0), (100.0, 120.0, 30.0),
        (1.0, 100.0, 0.1), (0.0, 40.0, 30.0), (-5.0, 40.0, 30.0), (1e-6, 25.0, 25.0),
        (3.0, 33.3, 33.3), (7.77, 99.95, 0.1), (10.0, 0.0, 0.0), (10.0, 50.0, 50.000001),
        (12345.678, 45.55, 54.46), (0.003, 70.0, 70.0), (1.0, -10.0, 30.0), (1.0, 40.0, -10.0),
    ]
    for a in fixed_q:
        qtys.append({"args": enc(list(a)), **run(partial_tp.calculate_partial_tp_qty, a)})
    for _ in range(300):
        a = (round(10 ** R.uniform(-7, 6), R.choice([0, 3, 6, 9])),
             R.choice([25.0, 40.0, 50.0, 30.0, round(R.uniform(0, 100), 2)]),
             R.choice([25.0, 30.0, 40.0, 50.0, round(R.uniform(0, 100), 2)]))
        qtys.append({"args": enc(list(a)), **run(partial_tp.calculate_partial_tp_qty, a)})

    # ── bu_target_price ────────────────────────────────────────────────────
    for a in [(100.0, "LONG"), (100.0, "SHORT"), (100.0, "long"), (100.0, "x"), (0.0001234, "short"),
              (100.0, "LONG", 0.0), (100.0, "SHORT", 0.01), (50000.5, "Long", 0.00055)]:
        bus.append({"args": enc(list(a)), **run(partial_tp.bu_target_price, a)})
    for _ in range(150):
        a = (rnd_price(), R.choice(DIRS), R.choice([0.0015, 0.0011, 0.002, R.uniform(0, 0.01)]))
        bus.append({"args": enc(list(a)), **run(partial_tp.bu_target_price, a)})

    # ── should_apply_bu_after_partial ──────────────────────────────────────
    def sh(kw):
        LOGS.clear()
        try:
            out = {"ret": partial_tp.should_apply_bu_after_partial(**kw)}
        except Exception as e:  # noqa: BLE001
            out = {"raise": [type(e).__name__, str(e)]}
        out["logs"] = list(LOGS)
        shoulds.append({"kw": {k: enc(v) for k, v in kw.items()}, **out})

    base = dict(initial_qty=10.0, pos_size_now=6.0, current_sl=98.0, entry=100.0, direction="LONG",
                be_already_set=False)
    sh(base)
    sh({**base, "be_already_set": True})
    sh({**base, "initial_qty": 0.0})
    sh({**base, "pos_size_now": 0.0})
    sh({**base, "pos_size_now": 9.5})
    sh({**base, "pos_size_now": 9.4999})
    sh({**base, "pos_size_now": 12.0})
    sh({**base, "current_sl": 0.0})
    sh({**base, "current_sl": -1.0})
    sh({**base, "current_sl": 100.0})
    sh({**base, "current_sl": 100.2})
    sh({**base, "direction": "SHORT", "current_sl": 102.0})
    sh({**base, "direction": "short", "current_sl": 100.0})
    sh({**base, "direction": "SHORT", "current_sl": 99.0})
    sh({**base, "direction": "SHORT", "current_sl": 0.0})
    sh({**base, "direction": "BUY"})
    sh({**base, "direction": ""})
    sh({**base, "threshold": 0.5})
    sh({**base, "threshold": 0.7})
    sh({**base, "mark_price": 103.6, "sl_dist": 2.0})
    sh({**base, "mark_price": 103.59, "sl_dist": 2.0})
    sh({**base, "mark_price": 103.6, "sl_dist": 2.0, "min_progression_r": 0.0})
    sh({**base, "mark_price": 101.0, "sl_dist": 0.0})
    sh({**base, "mark_price": 0.0, "sl_dist": 2.0})
    sh({**base, "direction": "SHORT", "current_sl": 102.0, "mark_price": 96.4, "sl_dist": 2.0})
    sh({**base, "direction": "SHORT", "current_sl": 102.0, "mark_price": 96.41, "sl_dist": 2.0})
    sh({**base, "mark_price": 99.0, "sl_dist": 2.0, "min_progression_r": -1.0})
    for _ in range(400):
        e = rnd_price()
        d = R.choice(DIRS)
        iq = R.choice([0.0, round(10 ** R.uniform(-4, 4), 6)])
        kw = dict(initial_qty=iq,
                  pos_size_now=R.choice([0.0, iq, round(iq * R.uniform(0.1, 1.2), 6)]),
                  current_sl=R.choice([0.0, e, round(e * R.uniform(0.9, 1.1), 8)]),
                  entry=e, direction=d, be_already_set=R.random() < 0.15)
        if R.random() < 0.5:
            kw["threshold"] = R.choice([0.95, 0.9, 0.5, round(R.uniform(0.1, 1.0), 3)])
        if R.random() < 0.6:
            sd = round(e * R.uniform(0.002, 0.05), 8)
            kw["mark_price"] = round(e * R.uniform(0.9, 1.15), 8)
            kw["sl_dist"] = R.choice([0.0, sd])
            if R.random() < 0.5:
                kw["min_progression_r"] = R.choice([1.8, 1.0, 0.0, round(R.uniform(0, 3), 2)])
        sh(kw)

    data = {"prices": prices, "qtys": qtys, "bu": bus, "should": shoulds}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        f.write("\n")
    print(f"wrote {OUT}: prices={len(prices)} qtys={len(qtys)} bu={len(bus)} should={len(shoulds)}")


if __name__ == "__main__":
    main()
