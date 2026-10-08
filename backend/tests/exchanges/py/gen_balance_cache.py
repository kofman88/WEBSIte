"""Drive balance_cache.get_cached_balance / gc_cache through a scripted sequence and record
the results, the trader calls made and the cache size (→ ../fixtures/balance_cache.json).

  cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \
    $VENV/bin/python /path/to/backend/tests/exchanges/py/gen_balance_cache.py; rm -f signal_registry.json

Each step: {op: "get", user: {...}, exchange, reply: value | {"raise": msg} | {"timeout": true}}
           {op: "advance", s}    {op: "gc"}
"""
import asyncio
import json
import os
import sys
import types

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
sys.path.insert(0, BOT)
os.chdir(BOT)

import balance_cache as bc  # noqa: E402
import bybit_trader  # noqa: E402
import bingx_trader  # noqa: E402
import binance_trader  # noqa: E402
import okx_trader  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


class Clock:
    t = 1767225600.0


clock = Clock()
bc.time = types.SimpleNamespace(time=lambda: clock.t)
calls = []
reply = {"v": None}


def make(ex):
    async def _get_balance(*args, **kwargs):
        calls.append({"exchange": ex, "args": list(args), "kwargs": kwargs})
        r = reply["v"]
        if isinstance(r, dict) and "raise" in r:
            raise RuntimeError(r["raise"])
        if isinstance(r, dict) and r.get("timeout"):
            raise asyncio.TimeoutError()
        return r
    return _get_balance


bybit_trader.get_balance = make("bybit")
bingx_trader.get_balance = make("bingx")
binance_trader.get_balance = make("binance")
okx_trader.get_balance = make("okx")


def U(uid, **kw):
    return dict({"user_id": uid}, **kw)


BY = {"bybit_api_key": "bk", "bybit_api_secret": "bs"}
STEPS = [
    {"op": "get", "user": U(0, **BY), "exchange": "bybit", "reply": 1.0},
    {"op": "get", "user": U(-5, **BY), "exchange": "bybit", "reply": 1.0},
    {"op": "get", "user": U(7, **BY, bybit_demo=1), "exchange": "bybit", "reply": 123.45},
    {"op": "advance", "s": 30},
    {"op": "get", "user": U(7, **BY), "exchange": "bybit", "reply": 999.0},
    {"op": "advance", "s": 30},
    {"op": "get", "user": U(7, **BY), "exchange": "bybit", "reply": None},
    {"op": "get", "user": U("12", okx_api_key="ok", okx_api_secret="os", okx_passphrase="pp"), "exchange": "okx", "reply": "88.5"},
    {"op": "get", "user": U(12, okx_api_key="ok", okx_api_secret="os"), "exchange": "okx", "reply": 1},
    {"op": "get", "user": U(13, bingx_api_key="xk", bingx_api_secret=""), "exchange": "bingx", "reply": 5.0},
    {"op": "get", "user": U(13, bingx_api_key="xk", bingx_api_secret="xs"), "exchange": "bingx", "reply": 0},
    {"op": "get", "user": U(14, binance_api_key="nk", binance_api_secret="ns"), "exchange": "binance", "reply": {"raise": "boom"}},
    {"op": "get", "user": U(14, binance_api_key="nk", binance_api_secret="ns"), "exchange": "binance", "reply": {"timeout": True}},
    {"op": "get", "user": U(14, binance_api_key="nk", binance_api_secret="ns"), "exchange": "binance", "reply": 42.25},
    {"op": "get", "user": U(15, kraken_api_key="k", kraken_api_secret="s"), "exchange": "kraken", "reply": 1.0},
    {"op": "get", "user": U(16, bybit_api_key="k", bybit_api_secret="s"), "exchange": "bybit", "reply": "abc"},
    {"op": "gc"},
    {"op": "advance", "s": 59.5},
    {"op": "gc"},
    {"op": "advance", "s": 1.0},
    {"op": "gc"},
    {"op": "get", "user": U(7, **BY), "exchange": "bybit", "reply": 5.0},
]


async def main():
    out = []
    for st in STEPS:
        if st["op"] == "advance":
            clock.t += st["s"]
            out.append({"step": st})
            continue
        if st["op"] == "gc":
            out.append({"step": st, "result": bc.gc_cache(), "size": len(bc._BALANCE_CACHE)})
            continue
        reply["v"] = st["reply"]
        calls.clear()
        res = await bc.get_cached_balance(types.SimpleNamespace(**st["user"]), st["exchange"])
        out.append({"step": st, "result": res, "calls": list(calls), "size": len(bc._BALANCE_CACHE)})
    return out


rows = asyncio.run(main())
with open(os.path.join(HERE, "..", "fixtures", "balance_cache.json"), "w", encoding="utf-8") as f:
    json.dump(rows, f, ensure_ascii=False, indent=1)
print("wrote", len(rows), "steps")
