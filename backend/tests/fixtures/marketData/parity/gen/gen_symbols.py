#!/usr/bin/env python
"""gen_symbols.py — every symbol-map function of the bot over a wide input set, without and with a live contract set.

  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 python gen_symbols.py > symbols.json
"""
import json, os, sys
BOT = os.environ.get("BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
sys.path.insert(0, BOT); os.chdir(BOT)
import fetcher_bingx as fb, bingx_trader as bt, bybit_trader as byt, binance_trader as bnt, fetcher

bases = sorted(set(list(bt._OKX_TO_BINGX_MULTIPLIER) + list(bt._OKX_TO_BINGX_NAME_ALIAS) + list(byt._OKX_TO_BYBIT_MULTIPLIER)
                   + list(byt._OKX_TO_BYBIT_NAME_ALIAS) + list(bnt._OKX_TO_BINANCE_MULTIPLIER) + list(bnt._OKX_TO_BINANCE_NAME_ALIAS)
                   + ["BTC", "ETH", "SOL", "TONCOIN", "LUNA2", "SHIB1000", "DOGE", "1000CAT", "NCCOGOLD2USD", "XAU2USD", "CAT", "WIF"]))
inputs = []
for b in bases:
    inputs += [f"{b}-USDT-SWAP", f"{b}USDT", f"{b}-USDT", f"{b.lower()}-usdt-swap", f"{b.lower()}usdt"]
inputs += ["BTC USDT", "BTC -USDT- SWAP", "", "1000PEPE-USDT-SWAP", "1000PEPE-USDT", "1000PEPEUSDT", "ETH-USD-SWAP", "BTC-USDC-SWAP",
           "USDT", "-USDT", "X-USDT-SWAP", "BTC-USDT-SWAP-X", "btc", "BTC-", "10000SATS-USDT", "1000000MOG-USDT-SWAP", "SHIB1000USDT", "LUNA2USDT",
           "btcusdt", " btc-usdt-swap ", "BTC_USDT", "ETHUSDT-SWAP", "USDTUSDT", "ABCUSDTX"]
inputs = list(dict.fromkeys(inputs))

def snap():
    out = {}
    for s in inputs:
        r = {}
        r["resolve"] = list(fb.resolve(s)); r["to_bingx"] = fb.to_bingx(s); r["price_multiplier"] = fb.price_multiplier(s)
        r["base_of"] = fb._base_of(s)
        r["to_bingx_symbol"] = bt.to_bingx_symbol(s); r["bingx_price_multiplier"] = bt.bingx_price_multiplier(s)
        r["to_bybit_symbol"] = byt.to_bybit_symbol(s); r["bybit_price_multiplier"] = byt.bybit_price_multiplier(s)
        r["to_binance_symbol"] = bnt.to_binance_symbol(s); r["binance_price_multiplier"] = bnt.binance_price_multiplier(s)
        r["to_okx"] = fetcher.OKXFetcher._to_okx(s)
        out[s] = r
    return out

bingx_names = ["BTC-USDT", "1000PEPE-USDT", "10000SATS-USDT", "1000000MOG-USDT", "1000000BABYDOGE-USDT", "TONCOIN-USDT", "TON-USDT", "LUNC-USDT",
               "1000LUNC-USDT", "SHIB-USDT", "1000SHIB-USDT", "1000FLOKI-USDT", "1000CAT-USDT", "1000X-USDT", "1000-USDT", "10001-USDT",
               "1000000-USDT", "10000PEPE-USDT", "1000000PEPE-USDT", "btc-usdt", "BTC-USDC", "BTCUSDT", "BTC-USDT-SWAP", "", "NCCOGOLD2USD-USDT",
               "NCSKAAPL-USDT", "NCFXEURUSD-USDT", "XAG2USD-USDT", "ncco-usdt", "GOLD2USDT-USDT", "USDT", "-USDT", "1000", "10000SATSX-USDT",
               "1000TONCOIN-USDT", "10000000X-USDT", "100000X-USDT", "1000 PEPE-USDT"]
result = {
    "inputs": inputs,
    "no_live": snap(),
    "from_bingx": {n: fb.from_bingx(n) for n in bingx_names},
    "is_non_crypto": {n: fb.is_non_crypto(n) for n in bingx_names},
    "maps": {
        "bingx_mult": bt._OKX_TO_BINGX_MULTIPLIER, "bingx_alias": bt._OKX_TO_BINGX_NAME_ALIAS,
        "bybit_mult": byt._OKX_TO_BYBIT_MULTIPLIER, "bybit_alias": byt._OKX_TO_BYBIT_NAME_ALIAS,
        "binance_mult": bnt._OKX_TO_BINANCE_MULTIPLIER, "binance_alias": bnt._OKX_TO_BINANCE_NAME_ALIAS,
        "mult_prefixes": list(fb._MULT_PREFIXES), "non_crypto_prefixes": list(fb._NON_CRYPTO_PREFIXES),
    },
}
# remember_live with an empty / falsy list keeps the old (empty) set
fb.remember_live([]); fb.remember_live([None, ""])
result["live_after_empty"] = sorted(fb._LIVE)
LIVE_IN = ["BTC-USDT", "eth-usdt", "TON-USDT", "1000PEPE-USDT", "LUNC-USDT", "10000SATS-USDT", "1000000MOG-USDT", "SHIB-USDT", "1000FLOKI-USDT",
           "1000BONK-USDT", "SOL-USDT", "1000000BABYDOGE-USDT", "NCCOGOLD2USD-USDT", "XYZ-USDT", "1000CAT-USDT", "10000WIF-USDT", "", None, "DOGE-USDT",
           "1000XEC-USDT", "XEC-USDT"]
fb.remember_live(LIVE_IN)
result["live_in"] = LIVE_IN
result["live_set"] = sorted(fb._LIVE)
result["live"] = snap()
# a second remember_live replaces (not merges) the set
fb.remember_live(["BTC-USDT"])
result["live_replaced"] = sorted(fb._LIVE)
result["live_replaced_snap"] = {s: {"resolve": list(fb.resolve(s)), "to_bingx_symbol": bt.to_bingx_symbol(s), "bingx_price_multiplier": bt.bingx_price_multiplier(s)}
                                for s in ["TON-USDT-SWAP", "PEPE-USDT-SWAP", "SATS-USDT-SWAP", "BTC-USDT-SWAP"]}
json.dump(result, sys.stdout)
