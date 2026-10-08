#!/usr/bin/env python
"""gen_candle_store.py — candle_store.ensure_candles / _adaptive_freshness_ms / prefetch_top_coins / cleanup
on a temporary SQLite file with a fake clock and fake loaders; plus BingXHistoryLoader paging on a fake API.

  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 python gen_candle_store.py > candle_store.json
"""
import asyncio, json, os, sys, tempfile, time
BOT = os.environ.get("BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
sys.path.insert(0, BOT); os.chdir(BOT)
os.environ.setdefault("BOT_TOKEN_CHM", "test:token"); os.environ.setdefault("ADMIN_IDS", "123")
os.environ.pop("ADAPTIVE_CACHE_TTL_ENABLED", None)
CLOCK = {"t": 1_717_000_600.0}
time.time = lambda: CLOCK["t"]
import pandas as pd
import candle_store as cs, backtest, fetcher_bingx as fb

H = 3_600_000; D = 86_400_000; MIN = 60_000
TMP = tempfile.mkdtemp()
cs.DB_PATH = os.path.join(TMP, "candle_cache.db")
cs._initialized_paths.clear()

def bars(last_open, tf_ms, n, base=100.0, step=0.25, rng=1.0, vol=10.0):
    out = []
    for i in range(n):
        p = base + i * step
        out.append([last_open - (n - 1 - i) * tf_ms, p, p + rng, p - rng, p + step / 2, vol + i])
    return out

def to_df(b):
    if b is None:
        return None
    df = pd.DataFrame(b, columns=["open_time", "open", "high", "low", "close", "volume"])
    df["open_time"] = pd.to_datetime(df["open_time"].astype("int64"), unit="ms")
    return df.set_index("open_time").astype(float)

def df_out(df):
    if df is None:
        return None
    return {"t": [int(x) for x in (df.index.astype("int64") // 10**6).tolist()], "o": df["open"].tolist(), "h": df["high"].tolist(),
            "l": df["low"].tolist(), "c": df["close"].tolist(), "v": df["volume"].tolist()}

class Loader:
    def __init__(self, result):
        self.result = result; self.calls = []
    async def load(self, symbol, tf, days):
        self.calls.append([symbol, tf, days])
        if isinstance(self.result, Exception):
            raise self.result
        return to_df(self.result)

async def count_rows(symbol, tf):
    import aiosqlite
    async with aiosqlite.connect(cs._db_path()) as db:
        async with db.execute("SELECT COUNT(*) FROM candles WHERE symbol=? AND timeframe=?", (symbol, tf)) as cur:
            return (await cur.fetchone())[0]

scenarios = []
async def run(name, symbol, tf, days, loader_result, clock=None, env_adaptive=None, seed=None):
    if clock is not None:
        CLOCK["t"] = clock
    if env_adaptive is None:
        os.environ.pop("ADAPTIVE_CACHE_TTL_ENABLED", None)
    else:
        os.environ["ADAPTIVE_CACHE_TTL_ENABLED"] = env_adaptive
    if seed is not None:
        await cs.store_candles(symbol, tf, to_df(seed))
    loader = Loader(loader_result)
    res = await cs.ensure_candles(symbol, tf, days, loader)
    scenarios.append({"name": name, "symbol": symbol, "tf": tf, "days": days, "now_ms": int(CLOCK["t"] * 1000),
                      "env_adaptive": env_adaptive, "seed": seed,
                      "loader_result": None if isinstance(loader_result, Exception) else loader_result,
                      "loader_raises": isinstance(loader_result, Exception),
                      "loader_calls": loader.calls, "result": df_out(res),
                      "coverage": list(await cs.get_coverage(symbol, tf)), "rows": await count_rows(symbol, tf)})

async def main():
    now_ms = int(CLOCK["t"] * 1000)
    # S1 empty store → load 100 bars (last closed 1 h ago)
    F1 = bars(now_ms - H, H, 100, base=100.0)
    await run("S1_empty_load", "A-USDT-SWAP", "1h", 3, F1)
    # S2 same call → HIT (loader not called); rows within [start, now]
    await run("S2_hit", "A-USDT-SWAP", "1h", 3, bars(now_ms - H, H, 5, base=999.0))
    # S2b newest exactly 2 h old (now = newest + 2 h) → still fresh (>=)
    await run("S2b_exactly_2h", "A-USDT-SWAP", "1h", 3, bars(now_ms - H, H, 5, base=888.0), clock=(now_ms - H) / 1000 + 2 * 3600)
    # S3 newest 2 h + 1 ms old → load again (result = loader frame only)
    F2 = bars(now_ms + H, H, 10, base=200.0)
    await run("S3_stale_newest", "A-USDT-SWAP", "1h", 3, F2, clock=(now_ms - H) / 1000 + 2 * 3600 + 0.001)
    # S4 not enough history (oldest > start) → load 10 days on 4h
    CLOCK["t"] = 1_717_000_600.0
    F3 = bars(now_ms - 2 * H, 4 * H, 70, base=50.0)
    await run("S4_short_history", "A2-USDT-SWAP", "4h", 10, F3, seed=bars(now_ms - 2 * H, 4 * H, 55, base=49.0))
    # S5 fresh and covered but 49 rows inside [start, now] → load → loader returns None → None
    #    rows every 28.5 min: k=1..50 → the oldest (k=50, now-1425 min) is inside the 1-day window → 50 rows; k=51 is outside
    seed50 = [[now_ms - k * 28 * MIN - k * 30_000, 10.0 + k, 11.0 + k, 9.0 + k, 10.5 + k, 1.0] for k in range(1, 52)]
    await run("S5_exactly_50_in_window_hit", "B-USDT-SWAP", "15m", 1, None, seed=seed50)
    seed49 = [[now_ms - k * 28 * MIN - k * 30_000, 20.0 + k, 21.0 + k, 19.0 + k, 20.5 + k, 1.0] for k in range(2, 52)]
    await run("S5b_49_in_window_load_none", "B2-USDT-SWAP", "15m", 1, None, seed=seed49)
    # S6 loader raises with ≥ 50 cached rows → FALLBACK; with < 50 → None
    await run("S6_raise_fallback", "C-USDT-SWAP", "4h", 30, RuntimeError("boom"), seed=bars(now_ms - 3 * H, 4 * H, 60, base=20.0))
    await run("S6b_raise_none", "D-USDT-SWAP", "4h", 30, RuntimeError("boom"), seed=bars(now_ms - 3 * H, 4 * H, 10, base=30.0))
    # S7 loader returns empty frame → None
    await run("S7_empty_frame", "E-USDT-SWAP", "15m", 2, [])
    # S8 adaptive on: volatile last 5 bars (range ×10), newest 61 min old on 1h, 100 bars / 3 days (72 in window)
    #    → adaptive 30 min < 61 min → load
    vol = bars(now_ms - 61 * MIN, H, 100, base=40.0, rng=1.0)
    for i in range(95, 100):
        vol[i][2] = vol[i][1] + 10.0; vol[i][3] = vol[i][1] - 10.0
    await run("S8_adaptive_volatile_load", "F-USDT-SWAP", "1h", 3, bars(now_ms - 10, H, 3, base=41.0), env_adaptive="1", seed=vol)
    # S8b adaptive on, calm (last 5 ranges tiny) → ttl 1.5 h, floored at 2 h → hit (newest 61 min old)
    calm = bars(now_ms - 61 * MIN, H, 100, base=60.0, rng=1.0)
    for i in range(95, 100):
        calm[i][2] = calm[i][1] + 0.01; calm[i][3] = calm[i][1] - 0.01
    await run("S8b_adaptive_calm_hit", "G-USDT-SWAP", "1h", 3, None, env_adaptive="1", seed=calm)
    # S8c same volatile data but the env flag is "true" (not "1") → legacy 2 h → hit
    await run("S8c_adaptive_env_true_is_off", "H-USDT-SWAP", "1h", 3, None, env_adaptive="true", seed=vol)
    # S8d adaptive on, volatile on 1d (base 1 d → 12 h, newest 61 min), 60 bars / 55 days → hit
    vol1d = [[t, o, h, l, c, v] for t, o, h, l, c, v in bars(now_ms - 61 * MIN, D, 60, base=70.0)]
    for i in range(55, 60):
        vol1d[i][2] = vol1d[i][1] + 10.0; vol1d[i][3] = vol1d[i][1] - 10.0
    await run("S8d_adaptive_volatile_1d_hit", "I-USDT-SWAP", "1d", 55, None, env_adaptive="1", seed=vol1d)
    # S8e adaptive on, volatile 1h, newest 29 min old → adaptive 30 min not exceeded → hit
    vol29 = bars(now_ms - 29 * MIN, H, 100, base=45.0, rng=1.0)
    for i in range(95, 100):
        vol29[i][2] = vol29[i][1] + 10.0; vol29[i][3] = vol29[i][1] - 10.0
    await run("S8e_adaptive_volatile_fresh_hit", "J-USDT-SWAP", "1h", 3, None, env_adaptive="1", seed=vol29)
    # S9 days = 0 → start = now → no rows in [now, now] → load
    await run("S9_days_zero", "B-USDT-SWAP", "15m", 0, bars(now_ms - H, H, 2, base=12.0))

    # ── _adaptive_freshness_ms direct cases ──
    adaptive = []
    def ad(name, b, tf, env):
        if env is None:
            os.environ.pop("ADAPTIVE_CACHE_TTL_ENABLED", None)
        else:
            os.environ["ADAPTIVE_CACHE_TTL_ENABLED"] = env
        adaptive.append({"name": name, "bars": b, "tf": tf, "env": env, "expected": cs._adaptive_freshness_ms(to_df(b) if b is not None else None, tf)})
    ad("off_none", None, "1h", None); ad("off_df", bars(0, H, 60), "15m", "0"); ad("off_env_1_spaces", bars(0, H, 60), "15m", " 1 ")
    ad("on_none", None, "1h", "1"); ad("on_small", bars(0, H, 49), "1h", "1"); ad("on_unknown_tf", bars(0, H, 60), "2h", "1")
    ad("on_flat", bars(0, H, 60, rng=0.0), "1h", "1"); ad("on_normal", bars(0, H, 60), "1d", "1")
    ad("on_volatile_1d", vol, "1d", "1"); ad("on_volatile_1m", vol, "1m", "1"); ad("on_volatile_15m", vol, "15m", "1"); ad("on_volatile_1h", vol, "1h", "1")
    ad("on_calm_1d", calm, "1d", "1"); ad("on_calm_4h", calm, "4h", "1"); ad("on_calm_5m", calm, "5m", "1")
    edge = bars(0, H, 60)
    for i in range(55, 60):
        edge[i][2] = edge[i][1] + 1.5; edge[i][3] = edge[i][1] - 1.5   # ratio exactly 1.5 → not > 1.5
    ad("on_ratio_1_5_edge", edge, "1h", "1")
    os.environ.pop("ADAPTIVE_CACHE_TTL_ENABLED", None)

    # ── prefetch_top_coins ──
    CLOCK["t"] = 1_717_000_600.0
    now_ms = int(CLOCK["t"] * 1000)
    P_LOADER = {"PB-USDT-SWAP": bars(now_ms - H, H, 24 * 6, base=5.0), "PC-USDT-SWAP": None, "PA-USDT-SWAP": bars(now_ms - H, H, 24 * 6, base=6.0)}
    P_SEEDS = {"PA-USDT-SWAP|1h": bars(now_ms - 3 * H, H, 24 * 6, base=5.0),    # covered, 3 h old (< 4 h) → cached
               "PA-USDT-SWAP|4h": bars(now_ms - 5 * H, 4 * H, 40, base=5.0)}   # 5 h old → reload
    class PLoader:
        def __init__(self):
            self.calls = []; self.top = []
        async def get_top_coins(self, min_volume_usdt=5_000_000):
            self.top.append(min_volume_usdt)
            return ["PA-USDT-SWAP", "PB-USDT-SWAP", "PC-USDT-SWAP", "PD-USDT-SWAP"]
        async def load(self, symbol, tf, days):
            self.calls.append([symbol, tf, days])
            return to_df(P_LOADER.get(symbol))
    for k, b in P_SEEDS.items():
        await cs.store_candles(k.split("|")[0], k.split("|")[1], to_df(b))
    pl = PLoader()
    stats = await cs.prefetch_top_coins(pl, top_n=3, tfs=["1h", "4h"], days=5)
    prefetch = {"now_ms": now_ms, "seeds": P_SEEDS, "loader": P_LOADER, "top_n": 3, "tfs": ["1h", "4h"], "days": 5,
                "stats": stats, "calls": pl.calls, "top_args": pl.top,
                "rows": {"PA_1h": await count_rows("PA-USDT-SWAP", "1h"), "PA_4h": await count_rows("PA-USDT-SWAP", "4h"), "PB_1h": await count_rows("PB-USDT-SWAP", "1h")}}

    # ── cleanup ──
    cutoff = int((CLOCK["t"] - cs.MAX_AGE_DAYS * 86400) * 1000)
    C_SEEDS = {"OLD-USDT-SWAP|1h": bars(now_ms - 400 * D, H, 10, base=1.0),
               "MIX-USDT-SWAP|1h": bars(now_ms - 366 * D, H, 5, base=2.0) + bars(now_ms - H, H, 5, base=3.0),
               "EDGE-USDT-SWAP|1h": [[cutoff - 1, 1, 1, 1, 1, 1], [cutoff, 2, 2, 2, 2, 2]]}
    for k, b in C_SEEDS.items():
        await cs.store_candles(k.split("|")[0], k.split("|")[1], to_df(b))
    before = await cs.cache_stats()
    deleted = await cs.cleanup()
    after = await cs.cache_stats()
    cleanup = {"now_ms": now_ms, "seeds": C_SEEDS, "deleted": deleted, "before": {"symbols": before["symbols"], "candles": before["candles"]},
               "after": {"symbols": after["symbols"], "candles": after["candles"]},
               "cov_old": list(await cs.get_coverage("OLD-USDT-SWAP", "1h")),
               "cov_mix_meta_quirk": list(await cs.get_coverage("MIX-USDT-SWAP", "1h")), "rows_mix": await count_rows("MIX-USDT-SWAP", "1h"),
               "rows_edge": await count_rows("EDGE-USDT-SWAP", "1h"),
               "cutoff_ms": int((CLOCK["t"] - cs.MAX_AGE_DAYS * 86400) * 1000)}

    # ── BingXHistoryLoader paging on a fake API ──
    paging = []
    async def page(name, symbol, tf, days, listing_ms, now_s, tf_ms):
        CLOCK["t"] = now_s
        nowms = int(now_s * 1000)
        # full synthetic history: aligned grid from listing_ms to the last open <= now
        first = ((listing_ms + tf_ms - 1) // tf_ms) * tf_ms
        last = (nowms // tf_ms) * tf_ms
        grid = list(range(first, last + 1, tf_ms)) if last >= first else []
        def row(t):
            i = (t - first) // tf_ms
            p = 100 + (i % 97) * 0.25
            return {"open": str(p), "high": str(p + 0.5), "low": str(p - 0.5), "close": str(p + 0.125), "volume": str(1000 + i), "time": t}
        calls = []
        async def fake_get_json(sess, url, params, what=""):
            calls.append([url.rsplit("/", 1)[-1], dict(params)])
            if "startTime" not in params:
                return {"code": 0, "data": []}
            s, e, lim = int(params["startTime"]), int(params["endTime"]), int(params["limit"])
            sel = [t for t in grid if s <= t <= e]
            sel = sel[-lim:]
            return {"code": 0, "data": [row(t) for t in reversed(sel)]}
        loader = backtest.BingXHistoryLoader()
        loader._get_json = fake_get_json
        async def _sess(): return None
        loader._sess = _sess
        df = await loader.load(symbol, tf, days)
        out = None
        if df is not None:
            d = df_out(df)
            out = {"t": d["t"], "head": [[d["o"][i], d["h"][i], d["l"][i], d["c"][i], d["v"][i]] for i in range(min(3, len(d["t"])))],
                   "tail": [[d["o"][i], d["h"][i], d["l"][i], d["c"][i], d["v"][i]] for i in range(max(0, len(d["t"]) - 3), len(d["t"]))]}
        paging.append({"name": name, "symbol": symbol, "tf": tf, "days": days, "listing_ms": listing_ms, "now_ms": nowms, "tf_ms": tf_ms,
                       "grid_first": first, "grid_last": last, "grid_n": len(grid), "calls": calls, "result": out})
    await page("P1_btc_1h_90d", "BTC-USDT-SWAP", "1h", 90, 1_600_000_000_000, 1_717_000_600.0, H)
    await page("P2_eth_15m_30d", "ETH-USDT-SWAP", "15m", 30, 1_600_000_000_000, 1_717_000_600.0, 15 * MIN)
    await page("P3_pepe_1h_30d_mult", "PEPE-USDT-SWAP", "1h", 30, 1_600_000_000_000, 1_717_000_600.0, H)
    await page("P4_recent_listing", "NEW-USDT-SWAP", "1h", 30, 1_717_000_600_000 - 10 * D + 1234, 1_717_000_600.0, H)
    await page("P5_no_history", "NONE-USDT-SWAP", "1h", 30, 1_717_000_600_000 + D, 1_717_000_600.0, H)
    await page("P6_4h_365d", "SOL-USDT-SWAP", "4h", 365, 1_500_000_000_000, 1_717_000_600.0, 4 * H)
    await page("P7_1d_400d_1D_spelling", "SOL-USDT-SWAP", "1D", 400, 1_500_000_000_000, 1_717_000_600.0, D)
    await page("P8_unknown_tf_1h_default", "SOL-USDT-SWAP", "7h", 2, 1_600_000_000_000, 1_717_000_600.0, H)
    await page("P9_now_10min_past_open_last_bar_forming", "BTC-USDT-SWAP", "1h", 1, 1_600_000_000_000, 1_717_000_600.0 - 600 + 3600, H)
    await page("P10_days_0", "BTC-USDT-SWAP", "1h", 0, 1_600_000_000_000, 1_717_000_600.0, H)
    await page("P11_listing_exactly_cutoff", "BTC-USDT-SWAP", "1h", 2, 1_717_000_600_000 - 2 * D, 1_717_000_600.0, H)
    await page("P12_listing_mid_last_page", "BTC-USDT-SWAP", "1h", 90, 1_717_000_600_000 - 1500 * H, 1_717_000_600.0, H)

    # get_top_coins
    contracts = {"code": 0, "data": [{"symbol": "BTC-USDT", "status": 1}, {"symbol": "1000PEPE-USDT", "status": "1"}, {"symbol": "DEAD-USDT", "status": 0},
                                     {"symbol": "NCCOGOLD2USD-USDT", "status": 1}, {"symbol": "TONCOIN-USDT", "status": "true"}, {"symbol": "LOW-USDT"}]}
    tickers = {"code": 0, "data": [{"symbol": "BTC-USDT", "quoteVolume": "900000000"}, {"symbol": "1000PEPE-USDT", "quoteVolume": "50000000"},
                                   {"symbol": "DEAD-USDT", "quoteVolume": "99999999999"}, {"symbol": "TONCOIN-USDT", "quoteVolume": "6000000"},
                                   {"symbol": "LOW-USDT", "quoteVolume": "abc"}, {"symbol": "NCCOGOLD2USD-USDT", "quoteVolume": "7000000000"},
                                   {"symbol": "UNLISTED-USDT", "quoteVolume": "8000000"}, {"symbol": "ETH-USDC", "quoteVolume": "8000000"},
                                   {"symbol": "TIE1-USDT", "quoteVolume": "5000000"}, {"symbol": "TIE2-USDT", "quoteVolume": 5000000}]}
    contracts["data"] += [{"symbol": "TIE1-USDT", "status": 1}, {"symbol": "TIE2-USDT", "status": 1}]
    top = {"contracts": contracts, "tickers": tickers}
    for variant, (c, t) in {"both": (contracts, tickers), "no_contracts": (None, tickers), "no_tickers": (contracts, None)}.items():
        loader = backtest.BingXHistoryLoader()
        async def fake(sess, url, params, what="", _c=c, _t=t):
            return _c if "contracts" in url else _t
        loader._get_json = fake
        async def _sess(): return None
        loader._sess = _sess
        top[variant] = await loader.get_top_coins(min_volume_usdt=5_000_000)
    top["live_after"] = sorted(fb._LIVE)

    json.dump({"scenarios": scenarios, "adaptive": adaptive, "prefetch": prefetch, "cleanup": cleanup, "paging": paging, "top_coins": top}, sys.stdout)

asyncio.run(main())
