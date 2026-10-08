#!/usr/bin/env python
"""gen_ws_state.py — drive ws_feed_bingx.BingXWebSocketFeed (_on_kline / _close_stale_bars / _handle_message)
with scripted inputs, a fake REST fetcher and a fake clock; dump the cache, bar state and events after every step.
Cache bars are dumped only when they changed since the previous step ({"same": true} otherwise).

  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 python gen_ws_state.py > ws_state.json
"""
import asyncio, json, os, sys, time
BOT = os.environ.get("BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
sys.path.insert(0, BOT); os.chdir(BOT)
os.environ.setdefault("BOT_TOKEN_CHM", "test:token"); os.environ.setdefault("ADMIN_IDS", "123")
CLOCK = {"t": 1_700_000_000.0}
time.time = lambda: CLOCK["t"]
import pandas as pd
import cache, ws_feed, ws_feed_bingx as wb

M = 60_000; TF15 = 15 * M; TF1H = 60 * M; TF4H = 240 * M
B15 = 1_700_000_100_000   # aligned 15m open
B1H = 1_700_002_800_000   # aligned 1h open
B4H = 1_700_006_400_000   # aligned 4h open

def mk_bars(last_open, tf_ms, n, base, step):
    out = []
    for i in range(n):
        p = round(base + i * step, 10)
        out.append([last_open - (n - 1 - i) * tf_ms, p, round(p * 1.01, 10), round(p * 0.99, 10), round(p + step / 2, 10), round(1000.0 + i * 3.5, 6)])
    return out

# REST responses per channel (queue; the last entry repeats). Prices already in OKX units.
REST = {
    "BTC-USDT-SWAP|15m": [mk_bars(B15 - TF15, TF15, 60, 40000.0, 1.5), mk_bars(B15 + 6 * TF15, TF15, 60, 40100.0, 2.0)],
    "PEPE-USDT-SWAP|1H": [None, mk_bars(B1H + TF1H, TF1H, 40, 0.0000123, 0.0000001)],
    "ETH-USDT-SWAP|4H": [mk_bars(B4H - TF4H, TF4H, 300, 2000.0, 0.25)],
    "SOL-USDT-SWAP|15m": [mk_bars(B15 - TF15, TF15, 20, 150.0, 0.1)],
}

class FakeFetcher:
    def __init__(self):
        self.calls = []
        self.q = {k: list(v) for k, v in REST.items()}
    async def get_candles(self, inst, tf, limit=300):
        self.calls.append([inst, tf, limit])
        q = self.q.get(f"{inst}|{tf}")
        if not q:
            return None
        bars = q.pop(0) if len(q) > 1 else q[0]
        if bars is None:
            return None
        df = pd.DataFrame(bars, columns=["open_time", "open", "high", "low", "close", "volume"])
        df["open_time"] = pd.to_datetime(df["open_time"].astype("int64"), unit="ms")
        return df.set_index("open_time").astype(float)

class FakeWS:
    closed = False
    def __init__(self): self.sent = []
    async def send_str(self, t): self.sent.append(t)

def kl(inst, tf, T, o, h, l, c, v):
    return {"op": "kline", "inst": inst, "tf": tf, "T": T, "o": o, "h": h, "l": l, "c": c, "v": v}

T1 = B15; T2 = B15 + TF15; T3 = B15 + 2 * TF15; T4 = B15 + 3 * TF15; T5 = B15 + 4 * TF15; T6 = B15 + 5 * TF15; T7 = B15 + 6 * TF15; T8 = B15 + 7 * TF15
P1 = B1H; P2 = B1H + TF1H; P3 = B1H + 2 * TF1H; P4 = B1H + 3 * TF1H
E1 = B4H; E2 = B4H + TF4H
S = "SOL-USDT-SWAP"

STEPS = [
    {"op": "clock", "t": 1_700_000_000.0},
    {"op": "subscribe", "inst": "BTC-USDT-SWAP", "tf": "15m"},
    {"op": "subscribe", "inst": "PEPE-USDT-SWAP", "tf": "1h"},     # tf normalised to 1H
    {"op": "subscribe", "inst": "ETH-USDT-SWAP", "tf": "4H"},
    {"op": "subscribe", "inst": S, "tf": "15m"},
    {"op": "subscribe", "inst": S, "tf": "15m"},                   # duplicate → no-op
    # ── A: BTC 15m — initial load on first forming push, throttle, close on newer T, late update, gap, out-of-order, stale timer
    kl("BTC-USDT-SWAP", "15m", T1, 40100.0, 40150.0, 40050.0, 40120.0, 12.5),
    {"op": "clock", "t": 1_700_000_002.0},
    kl("BTC-USDT-SWAP", "15m", T1, 40100.0, 40160.0, 40050.0, 40130.0, 13.0),     # same bar within 5 s → skipped
    {"op": "clock", "t": 1_700_000_006.5},
    kl("BTC-USDT-SWAP", "15m", T1, 40100.0, 40170.0, 40040.0, 40125.0, 14.0),     # synced (forming, not stored)
    {"op": "clock", "t": 1_700_000_900.0},
    kl("BTC-USDT-SWAP", "15m", T2, 40125.0, 40200.0, 40100.0, 40180.0, 1.0),      # closes T1 → appended + bar close
    kl("BTC-USDT-SWAP", "15m", T1, 40100.0, 40175.0, 40040.0, 40126.0, 14.2),     # late update of a closed bar → overwrite, no event
    {"op": "clock", "t": 1_700_001_800.0},
    kl("BTC-USDT-SWAP", "15m", T3, 40180.0, 40210.0, 40150.0, 40190.0, 2.0),      # closes T2
    {"op": "clock", "t": 1_700_003_600.0},
    kl("BTC-USDT-SWAP", "15m", T5, 40190.0, 40300.0, 40180.0, 40250.0, 3.0),      # T4 missing: closes T3, state T5
    kl("BTC-USDT-SWAP", "15m", T4, 40190.0, 40195.0, 40185.0, 40192.0, 0.5),      # out-of-order older bar → dropped
    {"op": "stale", "now_ms": T5 + TF15 + 14_999},                               # not yet
    {"op": "stale", "now_ms": T5 + TF15 + 15_000},                               # closes T5 by timer
    {"op": "stale", "now_ms": T5 + TF15 + 15_000},                               # duplicate timer → nothing
    kl("BTC-USDT-SWAP", "15m", T5, 40190.0, 40310.0, 40180.0, 40255.0, 3.3),      # late update after timer close → overwrite
    {"op": "clock", "t": 1_700_004_600.0},
    kl("BTC-USDT-SWAP", "15m", T6, 40255.0, 40260.0, 40200.0, 40230.0, 1.1),      # new bar; T5 already emitted → no duplicate close
    {"op": "stale", "now_ms": T6 + TF15 + 15_000},                               # closes T6
    {"op": "clock", "t": 1_700_005_500.0},
    kl("BTC-USDT-SWAP", "15m", T7, 40230.0, 40240.0, 40210.0, 40220.0, 0.7),      # forming T7 (recv before reconnect)
    {"op": "clock", "t": 1_700_005_600.0},
    {"op": "reconnect"},                                                         # connected_at = now
    {"op": "clock", "t": 1_700_006_400.0},
    kl("BTC-USDT-SWAP", "15m", T8, 40220.0, 40230.0, 40200.0, 40210.0, 0.9),      # closes T7 → recv_ts < connected_at → REST refresh
    {"op": "settle"},
    kl("BTC-USDT-SWAP", "15m", T7, 40230.0, 40245.0, 40210.0, 40221.0, 0.8),      # late update of T7 (in REST index) → overwrite
    # ── B: PEPE 1H ×1000 — REST fails first (reservation), closed bar lost, [WS-REFILL] after 60 s
    {"op": "clock", "t": 1_700_010_000.0},
    kl("PEPE-USDT-SWAP", "1H", P1, 0.0123, 0.0125, 0.0121, 0.0124, 5_000_000.0),  # cache empty → initial load → None
    {"op": "clock", "t": 1_700_010_030.0},
    kl("PEPE-USDT-SWAP", "1H", P2, 0.0124, 0.0126, 0.0122, 0.0125, 6_000_000.0),  # closes P1 → cache empty, reserved 30 s ago → lost
    {"op": "clock", "t": 1_700_010_061.0},
    kl("PEPE-USDT-SWAP", "1H", P3, 0.0125, 0.0127, 0.0123, 0.0126, 7_000_000.0),  # closes P2 → cache empty, stale → [WS-REFILL] load
    {"op": "clock", "t": 1_700_010_070.0},
    kl("PEPE-USDT-SWAP", "1H", P4, 0.0126, 0.0128, 0.0124, 0.0127, 8_000_000.0),  # closes P3 → appended (/1000, vol = v*c)
    kl("PEPE-USDT-SWAP", "1H", P2, 0.0124, 0.0129, 0.0122, 0.0125, 6_500_000.0),  # late update of P2 (in REST index) → overwrite
    # ── C: ETH 4H — preset 300 bars via REST, append trims to 300
    {"op": "clock", "t": 1_700_020_000.0},
    kl("ETH-USDT-SWAP", "4H", E1, 2075.0, 2080.0, 2070.0, 2078.0, 100.0),
    {"op": "clock", "t": 1_700_020_100.0},
    kl("ETH-USDT-SWAP", "4H", E2, 2078.0, 2090.0, 2077.0, 2085.0, 50.0),         # closes E1 → 301 → trim to 300
    # ── D: SOL 15m — raw messages through _handle_message
    {"op": "attach_ws"},
    {"op": "message", "text": '{"id":"abc","code":0,"msg":""}'},
    {"op": "message", "text": '{"code":100400,"msg":"bad","dataType":"SOL-USDT@kline_15m"}'},
    {"op": "message", "text": "Ping"},
    {"op": "message", "text": "  ping \n"},
    {"op": "message", "text": '{"ping": 17, "time": "2024"}'},
    {"op": "message", "text": '{"ping": 18}'},
    {"op": "message", "text": "Pong"},
    {"op": "message", "text": "garbage{"},
    {"op": "message", "text": "[1,2]"},
    {"op": "message", "text": ""},
    {"op": "message", "text": '{"code":0,"dataType":"DOGE-USDT@kline_15m","data":[{"o":"1","h":"1","l":"1","c":"1","v":"1","T":%d}]}' % B15},
    {"op": "message", "text": '{"code":0,"dataType":"SOL-USDT@kline_15m","data":[]}'},
    {"op": "clock", "t": 1_700_030_000.0},
    {"op": "message", "text": '{"code":0,"dataType":"SOL-USDT@kline_15m","s":"SOL-USDT","data":[{"c":"151.5","o":"151","h":"152","l":"150.5","v":"10","T":%d}]}' % (B15 + TF15 - 1)},  # close-time style T
    {"op": "clock", "t": 1_700_030_010.0},
    {"op": "message", "text": '{"code":0,"dataType":"SOL-USDT@kline_15m","data":[{"c":"153","o":"152","h":"153.5","l":"151.5","v":"4","T":%d},{"c":"152","o":"151.5","h":"152.5","l":"151","v":"11","T":%d},{"bad":1},"x",{"o":"1","h":"1","l":"1","c":"1","v":"1","T":"abc"}]}' % (B15 + 2 * TF15, B15 + TF15)},
    {"op": "clock", "t": 1_700_030_020.0},
    {"op": "message", "text": '{"code":"0","dataType":"SOL-USDT@kline_15m","data":{"c":"154","o":"153","h":"154.5","l":"152.5","v":"","t":%d}}' % (B15 + 3 * TF15)},
    {"op": "clock", "t": 1_700_030_030.0},
    {"op": "message", "text": '{"dataType":"SOL-USDT@kline_15m","data":[{"c":"155","o":"154","h":"155.5","l":"153.5","v":null,"time":%d}]}' % (B15 + 4 * TF15)},
    {"op": "message", "text": '{"code":0,"dataType":"SOL-USDT@kline_1h","data":[{"c":"155","o":"154","h":"155.5","l":"153.5","v":"1","T":%d}]}' % B1H},  # not subscribed
    {"op": "message", "text": '{"code":0,"dataType":"SOL-USDT@kline_15m","data":[{"c":"155","o":"154","h":"155.5","l":"153.5","T":%d}]}' % (B15 + 5 * TF15)},  # no v → 0
    {"op": "message", "text": '{"code":0,"dataType":"SOL-USDT@kline_15m","data":[{"c":"155","h":"155.5","l":"153.5","v":"1","T":%d}]}' % (B15 + 6 * TF15)},  # no o → skipped
    {"op": "message", "text": '{"code":null,"dataType":"SOL-USDT@kline_15m","data":[{"c":"156","o":"155","h":"156.5","l":"154.5","v":"2","T":%d}]}' % (B15 + 6 * TF15)},
    {"op": "message", "text": '{"code":0,"dataType":"SOL-USDT@kline_15m","data":[{"c":"157","o":"156","h":"157.5","l":"155.5","v":"3","T":%d.0}]}' % (B15 + 7 * TF15)},  # float T → int()
    {"op": "message", "text": '{"code":0,"dataType":"SOL-USDT@kline_15m","data":[{"c":"157","o":"156","h":"157.5","l":"155.5","v":"3","T":"%d"}]}' % (B15 + 8 * TF15)},  # str T
    {"op": "message", "text": '{"code":0,"dataType":"sol-usdt@KLINE_15m","data":[{"c":"1","o":"1","h":"1","l":"1","v":"1","T":%d}]}' % (B15 + 9 * TF15)},  # wrong case → not parsed
    {"op": "unsubscribe_check"},
]

EVENTS = []

def snapshot(feed, fetcher, ws, prev):
    cs = {}
    for key, (df, exp) in cache._candle_cache._data.items():
        bars = [[int(ts.value // 10**6), float(r.open), float(r.high), float(r.low), float(r.close), float(r.volume)]
                for ts, r in zip(df.index, df.itertuples())]
        if prev.get(key) == bars:
            cs[key] = {"same": True, "len": len(bars), "expires_at": exp}
        else:
            cs[key] = {"bars": bars, "expires_at": exp}
        prev[key] = bars
    for key in list(prev):
        if key not in cs:
            prev.pop(key)
    return {
        "cache": cs,
        "bar_state": {f"{k[0]}|{k[1]}": st for k, st in feed._bar_state.items()},
        "last_emitted": {f"{k[0]}|{k[1]}": v for k, v in feed._last_emitted.items()},
        "events": list(EVENTS),
        "counters": {"candles_received_total": feed._candles_received_total, "forming_skipped": feed._forming_skipped,
                     "pushes_received": feed._pushes_received, "pings_received": feed._pings_received, "pongs_sent": feed._pongs_sent,
                     "sub_errors": feed._sub_errors, "last_msg_ts": feed._last_msg_ts},
        "loaded_channels": sorted(feed._loaded_channels),
        "fetcher_calls": list(fetcher.calls),
        "sent": list(ws.sent),
        "subscriptions": sorted(f"{k[0]}|{k[1]}" for k in feed._subscriptions),
    }

async def main():
    cache.init_cache(4000)
    ws_feed.register_on_bar_close(lambda inst, tf: EVENTS.append([inst, tf]))
    fetcher = FakeFetcher()
    feed = wb.BingXWebSocketFeed(fetcher=fetcher, max_subscriptions=200)
    ws = FakeWS()
    steps = []
    prev = {}
    for st in STEPS:
        op = st["op"]
        if op == "clock":
            CLOCK["t"] = st["t"]
        elif op == "subscribe":
            feed.subscribe(st["inst"], st["tf"])
        elif op == "kline":
            await feed._on_kline((st["inst"], st["tf"]), st["T"], st["o"], st["h"], st["l"], st["c"], st["v"])
        elif op == "stale":
            await feed._close_stale_bars(st["now_ms"])
        elif op == "reconnect":
            feed._connected_at = time.time()
        elif op == "settle":
            for _ in range(8):
                await asyncio.sleep(0)
        elif op == "attach_ws":
            feed._ws = ws
        elif op == "message":
            await feed._handle_message(st["text"])
        elif op == "unsubscribe_check":
            feed._ws = None
            feed.unsubscribe(S, "15m")
        steps.append({"step": st, "state": snapshot(feed, fetcher, ws, prev)})
    json.dump({"rest": REST, "steps": steps}, sys.stdout)

asyncio.run(main())
