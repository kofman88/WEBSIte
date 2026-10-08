"""gen_coin_rand.py — the bot's coin_analysis.analyze_coin("AUTO") on RANDOM 1h cuts of every
golden symbol (off the stride grid of gen_coin_analysis_vectors.py; fetch = the last 300 CLOSED
bars at the cut, like a REST call), and the bot's REAL miniapp_api.h_analyze on adversarial
request bodies (symbol / strategy parsing, bad_symbol, the parsed symbol and the fetch calls),
for backend/tests/engine/stats/coinRand.test.js.

  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python gen_coin_rand.py /abs/coin_rand.json
  (afterwards: rm -f <bot>/signal_registry.json)
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import sys
from types import SimpleNamespace

import numpy as np
import pandas as pd

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "golden", "candles")
OUT = sys.argv[1]
os.chdir(BOT)
sys.path.insert(0, BOT)
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")

import coin_analysis as ca  # noqa: E402
import miniapp_api as ma  # noqa: E402

TF_MS = {"15m": 900_000, "1h": 3_600_000, "4h": 14_400_000}
_cache: dict = {}
rng = random.Random(6006)


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


symbols = [f["symbol"] for f in json.load(open(os.path.join(GOLDEN, "index.json")))["fixtures"]]
cases = []
for sym in symbols:
    d1 = load_df(sym, "1h")
    n = len(d1)
    for i in sorted(rng.sample(range(218, n), 3)):
        close_ms = int(d1.index.asi8[i] // 1_000_000) + TF_MS["1h"] + rng.choice([0, 0, 1, 899_999])
        calls = []

        async def fetch(s, tf, limit, _sym=sym, _close=close_ms, _calls=calls):
            _calls.append([s, tf, limit])
            return closed_upto(load_df(_sym, tf), tf, _close, limit)
        out = asyncio.run(ca.analyze_coin(sym, "AUTO", fetch))
        cases.append({"symbol": sym, "i": i, "close_ms": close_ms, "calls": calls, "signal": clean(out["signal"]),
                      "tried": list(out["tried"]), "candidates": clean(out["candidates"]),
                      "df_len": None if out["df"] is None else len(out["df"])})
print("cases", len(cases), "with signal", sum(1 for c in cases if c["signal"]),
      "multi", sum(1 for c in cases if len(c["candidates"]) > 1))

# ── h_analyze body parsing (the real handler; quota passes, the fetcher records and returns None) ──
FETCH_CALLS: list = []


class Fetcher:
    async def get_candles(self, sym, tf, limit=300):
        FETCH_CALLS.append([sym, tf, limit])
        return None

    async def get_24h_change(self, sym):
        FETCH_CALLS.append([sym, "24h", 0])
        return None


ma._ctx["scanner"] = SimpleNamespace(fetcher=Fetcher())


async def _lu(_req):
    return None, SimpleNamespace(user_id=1)


async def _allowed(_user):
    return None


ma._load_user = _lu
ma._analyze_allowed = _allowed
BODIES = [
    {"symbol": "btc"}, {"symbol": "BTCUSDT"}, {"symbol": "btc/usdt", "strategy": "smc"}, {"symbol": " eth \n"},
    {"symbol": "ETH\u001f"}, {"symbol": "ETH\u0085"}, {"symbol": "ETH﻿"}, {"symbol": " SOL"},
    {"symbol": "X"}, {"symbol": "ABCDEFGHIJKLMNOP"}, {"symbol": "ABCDEFGHIJKLMNO"}, {"symbol": "1000PEPE"},
    {"symbol": "BTC-USDT"}, {"symbol": "USDT"}, {"symbol": "USDTUSDT"}, {"symbol": "US/USDTDT"}, {"symbol": None},
    {"symbol": 123}, {"symbol": True}, {"symbol": ["BTC"]}, {"symbol": {"a": 1}}, {}, {"strategy": "AUTO"},
    {"symbol": "eth", "strategy": "levels"}, {"symbol": "eth", "strategy": "Volume"}, {"symbol": "eth", "strategy": "foo"},
    {"symbol": "eth", "strategy": None}, {"symbol": "eth", "strategy": 5}, {"symbol": "eth", "strategy": ""},
    {"symbol": "straße"}, {"symbol": "ﬁx"}, {"symbol": "ǆab"}, {"symbol": "btc\n"}, {"symbol": "BTC "},
    {"symbol": "ÉTH"}, {"symbol": "ab"}, {"symbol": "a\tb"},
]
parse = []
for b in BODIES:
    FETCH_CALLS.clear()

    class Req:
        async def json(self, _b=b):
            return _b
    resp = asyncio.run(ma.h_analyze(Req()))
    parse.append({"body": b, "status": resp.status, "resp": json.loads(resp.text), "calls": list(FETCH_CALLS)})

json.dump({"cases": cases, "parse": parse}, open(OUT, "w"), ensure_ascii=False, default=float)
print("written", OUT, len(cases), len(parse))
sys.stdout.flush()
os._exit(0)
