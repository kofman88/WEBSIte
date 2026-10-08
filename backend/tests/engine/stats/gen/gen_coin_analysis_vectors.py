"""gen_coin_analysis_vectors.py — real outputs of the bot's coin_analysis.py (run_strategy /
analyze_coin with AUTO ordering), handlers/guest._format_strategy_result and the Mini App
analyze quota (miniapp_api._analyze_allowed) for backend/tests/engine/stats/coinAnalysis.test.js.

The candles are the golden fixtures (backend/tests/golden/candles): for a cut at 1h bar i the
"fetch" returns what a REST call at the close of bar i would: the last 300 CLOSED bars of 1h /
4h / 15m.

  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python gen_coin_analysis_vectors.py OUT.json [STRIDE]
  (afterwards: rm -f <bot>/signal_registry.json)
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from types import SimpleNamespace

import numpy as np
import pandas as pd

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "golden", "candles")
OUT = sys.argv[1]
STRIDE = int(sys.argv[2]) if len(sys.argv) > 2 else 45
os.chdir(BOT)
sys.path.insert(0, BOT)
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")

import coin_analysis as ca  # noqa: E402

TF_MS = {"15m": 900_000, "1h": 3_600_000, "4h": 14_400_000}
_cache: dict = {}


def load_df(symbol, tf):
    key = (symbol, tf)
    if key not in _cache:
        fx = json.load(open(os.path.join(GOLDEN, f"{symbol}_{tf}.json")))
        arr = np.array(fx["bars"], dtype=float)
        idx = pd.to_datetime(arr[:, 0].astype("int64"), unit="ms")
        df = pd.DataFrame({"open": arr[:, 1], "high": arr[:, 2], "low": arr[:, 3], "close": arr[:, 4],
                           "volume": arr[:, 5]}, index=idx)
        df.index.name = "open_time"
        _cache[key] = df
    return _cache[key]


def closed_upto(df, tf, close_ms, n=300):
    open_ms = df.index.asi8 // 1_000_000
    sub = df[open_ms + TF_MS[tf] <= close_ms]
    return sub.tail(n) if len(sub) else None


def make_fetch(symbol, i, mode=None):
    d1 = load_df(symbol, "1h")
    close_ms = int(d1.index.asi8[i] // 1_000_000) + TF_MS["1h"]
    calls = []

    async def fetch(sym, tf, limit):
        calls.append([sym, tf, limit])
        if mode and tf in mode:
            if mode[tf] == "raise":
                raise RuntimeError("boom")
            if mode[tf] == "none":
                return None
            if mode[tf] == "short":
                return closed_upto(load_df(symbol, tf), tf, close_ms, 150)
        return closed_upto(load_df(symbol, tf), tf, close_ms, limit)
    return fetch, calls, close_ms


def clean(v):
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    if isinstance(v, np.floating):
        return float(v)
    if isinstance(v, np.integer):
        return int(v)
    return v


def view(out):
    return {"signal": clean(out["signal"]), "tried": list(out["tried"]),
            "candidates": clean(out["candidates"]), "df_len": None if out["df"] is None else len(out["df"])}


symbols = [f["symbol"] for f in json.load(open(os.path.join(GOLDEN, "index.json")))["fixtures"]]
cases = []
for si, sym in enumerate(symbols):
    n = len(load_df(sym, "1h"))
    for i in range(220 + (si * 7) % STRIDE, n, STRIDE):
        fetch, calls, close_ms = make_fetch(sym, i)
        out = asyncio.run(ca.analyze_coin(sym, "AUTO", fetch))
        cases.append({"symbol": sym, "i": i, "close_ms": close_ms, "strategy": "AUTO", "calls": calls, **view(out)})
print("auto cases", len(cases), "with signal", sum(1 for c in cases if c["signal"]))

# single-strategy runs + fetch failure modes on a handful of cuts
special = []
picks = [c for c in cases if c["candidates"]][:12] + [c for c in cases if not c["candidates"]][:4]
for c in picks:
    for strat, mode in (("LEVELS", None), ("SMC", None), ("VOLUME", None), ("smc", None), ("FOO", None),
                        ("SMC", {"4h": "raise"}), ("SMC", {"4h": "none"}), ("AUTO", {"15m": "none"}),
                        ("AUTO", {"1h": "none"}), ("AUTO", {"1h": "short"}), ("AUTO", {"4h": "short"})):
        fetch, calls, close_ms = make_fetch(c["symbol"], c["i"], mode)
        out = asyncio.run(ca.analyze_coin(c["symbol"], strat, fetch))
        special.append({"symbol": c["symbol"], "i": c["i"], "close_ms": close_ms, "strategy": strat, "mode": mode,
                        "calls": calls, **view(out)})

# text builders of the guest flow (handlers/guest.py) + the Mini App analyze payload
import handlers.guest as hg  # noqa: E402
texts = []
for c in [x for x in cases + special if x["signal"]][:40]:
    for data in (None, {"last": c["signal"]["entry"] * 1.001, "change_pct_24h": -1.234}, {"price": 0.012345, "change_pct_24h": 2.5}):
        for paid in (True, False):
            texts.append({"symbol": c["symbol"].replace("-USDT-SWAP", ""), "data": data, "sig": c["signal"], "paid": paid,
                          "auto": c["strategy"] == "AUTO", "tried": c["tried"], "ref": "https://t.me/CHM_signalS_bot?start=ref_7",
                          "text": hg._format_strategy_result(c["symbol"].replace("-USDT-SWAP", ""), data, c["signal"],
                                                             "https://t.me/CHM_signalS_bot?start=ref_7", paid,
                                                             auto=(c["strategy"] == "AUTO"), tried=c["tried"])})
extra_sigs = [
    {"direction": "SHORT", "entry": 0.0001234, "sl": 0.000125, "tp1": 0.00012, "tp2": 0.000118, "tp3": 0.000115,
     "quality": 5, "setup": "<b>x&y</b>", "reasons": ["a<b", "c", "d", "e", "f"], "strategy": "SMC", "bars_ago": 0},
    {"direction": "LONG", "entry": 100.0, "sl": 100.0, "tp1": 101.0, "tp2": 102.0, "tp3": 103.0,
     "quality": 1, "setup": "", "reasons": [], "strategy": "WEIRD", "bars_ago": 3},
    {"direction": "LONG", "entry": 0.0, "sl": 0.0, "tp1": 1.0, "tp2": 2.0, "tp3": 3.0,
     "quality": 3, "reasons": None, "strategy": "VOLUME", "bars_ago": 5},
]
for s in extra_sigs:
    for data in (None, {"last": 0, "change_pct_24h": 0}):
        texts.append({"symbol": "PEPE", "data": data, "sig": s, "paid": False, "auto": True, "tried": ["LEVELS", "SMC", "VOLUME"],
                      "ref": "https://t.me/x?start=ref_1",
                      "text": hg._format_strategy_result("PEPE", data, s, "https://t.me/x?start=ref_1", False, auto=True,
                                                         tried=["LEVELS", "SMC", "VOLUME"])})
labels = dict(ca.LABELS)
no_setup = {s: (f"⏳ <b>ETH</b>: по стратегии {ca.LABELS.get(s, '🤖 Авто')} "
                f"сейчас нет действующего сетапа (1h).\n"
                f"Попробуй другую стратегию или 🤖 Авто — или загляни позже: "
                f"бот следит за рынком 24/7.") for s in ("LEVELS", "SMC", "VOLUME", "AUTO")}

# Mini App analyze quota: _analyze_allowed with a fake kv + clock
import miniapp_api as ma  # noqa: E402
import database  # noqa: E402
KV: dict = {}
NOWQ = [1_766_000_000.0]
ma.time.time = lambda: NOWQ[0]


async def _count(uid):
    v = KV.get(f"analyze_count_{uid}_{int(NOWQ[0]) // 86400}")
    return int(v) if v else 0


async def _inc(uid):
    k = f"analyze_count_{uid}_{int(NOWQ[0]) // 86400}"
    KV[k] = str(int(KV.get(k, "0")) + 1)

database.db_count_user_analyzes_today = _count
database.db_inc_user_analyzes_today = _inc


class U(SimpleNamespace):
    def plan_limit(self, feat):
        if self.limit == "raise":
            raise RuntimeError("x")
        return self.limit


quota = []
ma._analyze_last.clear()
steps = [(0, 7, 1), (5, 7, 1), (10, 7, 1), (10.5, 7, 1), (30, 8, 999), (31, 8, 999), (45, 8, 999), (100, 9, 2), (111, 9, 2),
         (122, 9, 2), (86400 - 5, 9, 2), (86400 + 100, 9, 2), (86400 + 111, 9, 2), (200, 10, "raise"), (220, 10, "raise"),
         (240, 7, 1), (86400 + 300, 7, 1)]
for dt, uid, limit in steps:
    NOWQ[0] = 1_766_000_000.0 + dt
    u = U(user_id=uid, limit=limit, sub_plan="pro" if limit in (999, "raise") else "free", sub_status="active",
          sub_expires=2e9)
    res = asyncio.run(ma._analyze_allowed(u))
    quota.append({"t": NOWQ[0], "uid": uid, "limit": limit, "result": res, "kv": dict(KV)})

out = {"cases": cases, "special": special, "texts": texts, "labels": labels, "strategies": list(ca.STRATEGIES),
       "lookback": ca.LOOKBACK, "min_bars": ca._MIN_BARS, "no_setup": no_setup, "quota": quota,
       "symbol_re": ma._SYMBOL_RE.pattern, "cooldown_s": ma._ANALYZE_COOLDOWN_S}
json.dump(out, open(OUT, "w"), ensure_ascii=False, indent=0, default=float)
print("written", OUT, {k: len(v) if hasattr(v, "__len__") else v for k, v in out.items()})
sys.stdout.flush()
os._exit(0)
