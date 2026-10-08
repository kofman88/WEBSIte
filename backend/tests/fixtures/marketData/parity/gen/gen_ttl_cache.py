#!/usr/bin/env python
"""gen_ttl_cache.py — scripted ops on cache.TTLCache / the module-level cache with a fake clock.

  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 python gen_ttl_cache.py > ttl_cache.json
"""
import asyncio, json, os, sys, time
BOT = os.environ.get("BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
sys.path.insert(0, BOT); os.chdir(BOT)
CLOCK = {"t": 1000.0}
time.time = lambda: CLOCK["t"]
import cache

OPS = [
    ["set", "a", 1, 10], ["set", "b", 2, 10], ["set", "c", 3, 10], ["keys"], ["get", "a"], ["keys"], ["set", "d", 4, 10], ["keys"],
    ["get", "b"], ["get", "zz"], ["stats"], ["advance", 11], ["get", "c"], ["keys"], ["stats"], ["set", "a", 9, 5], ["keys"],
    ["set", "e", 5, 100], ["keys"], ["set", "f", 6, 100], ["keys"], ["advance", 5], ["get", "a"], ["advance", 1], ["get", "a"], ["keys"],
    ["get", "e"], ["delete", "e"], ["delete", "nope"], ["keys"], ["set", "g", 7, 0], ["get", "g"], ["advance", 0.5], ["get", "g"], ["keys"],
    ["set", "h", 8, 10], ["set", "i", 9, 10], ["set", "j", 10, 10], ["keys"], ["stats"], ["clear"], ["keys"], ["stats"], ["size"],
    ["set", "k", 11, 10], ["set", "k", 12, 10], ["set", "l", 13, 10], ["set", "m", 14, 10], ["set", "n", 15, 10], ["keys"], ["get", "k"], ["stats"],
    ["advance", 10], ["get", "l"], ["get", "m"], ["keys"], ["set", "o", 16, 10], ["keys"], ["stats"],
]

async def main():
    c = cache.TTLCache(max_size=3)
    steps = []
    for op in OPS:
        res = None
        if op[0] == "set":
            await c.set(op[1], op[2], op[3])
        elif op[0] == "get":
            res = await c.get(op[1])
        elif op[0] == "delete":
            await c.delete(op[1])
        elif op[0] == "clear":
            await c.clear()
        elif op[0] == "advance":
            CLOCK["t"] += op[1]
        elif op[0] == "keys":
            res = list(c._data.keys())
        elif op[0] == "stats":
            res = c.stats()
        elif op[0] == "size":
            res = c.size()
        steps.append({"op": op, "result": res, "keys": list(c._data.keys()),
                      "expires": {k: v[1] for k, v in c._data.items()}, "stats": c.stats(), "clock": CLOCK["t"]})
    # module-level API (normalised tf spellings only — PORT_DECISIONS D6 merges 1h/1H on the site)
    CLOCK["t"] = 5000.0
    cache.init_cache(2)
    mod = []
    await cache.set_candles("BTC-USDT-SWAP", "1H", "df1", {"1H": 100})
    await cache.set_candles("ETH-USDT-SWAP", "15m", "df2", {})           # default ttl 3600
    await cache.set_candles("SOL-USDT-SWAP", "4H", "df3", {"4H": 7, "15m": 1})  # evicts BTC (oldest)
    mod.append({"keys": list(cache._candle_cache._data.keys()), "expires": {k: v[1] for k, v in cache._candle_cache._data.items()}})
    mod.append({"get": [await cache.get_candles("BTC-USDT-SWAP", "1H"), await cache.get_candles("ETH-USDT-SWAP", "15m"), await cache.get_candles("SOL-USDT-SWAP", "4H")]})
    mod.append({"keys": list(cache._candle_cache._data.keys())})
    mod.append({"coins_before": await cache.get_coins()})
    await cache.set_coins(["A", "B"])
    mod.append({"coins": await cache.get_coins(), "coins_exp": cache._coins_cache[1]})
    CLOCK["t"] += 6 * 3600 - 1
    mod.append({"coins_5h59": await cache.get_coins()})
    CLOCK["t"] += 1
    mod.append({"coins_6h": await cache.get_coins()})
    CLOCK["t"] += 1
    mod.append({"coins_6h01": await cache.get_coins()})
    mod.append({"stats": cache.cache_stats()})
    json.dump({"ops": OPS, "steps": steps, "module": mod}, sys.stdout)

asyncio.run(main())
