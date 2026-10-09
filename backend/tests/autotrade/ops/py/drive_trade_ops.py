"""drive_trade_ops.py — the bot's own exchange-key / position Mini App handlers (miniapp_api.py
h_exchange_keys, h_exchange_keys_remove, h_positions — over HTTP on an aiohttp TestServer, raw request
targets) and its trade buttons (handlers/trading.py exec_trade, handlers/quick_close.py cb_qc_half /
cb_qc_full / cb_qc_full_force / cb_holdlock_wait / cb_qc_be / cb_qc_refresh — called with a recording
CallbackQuery) against a seeded temp DB and scripted exchanges, for
backend/tests/autotrade/ops/tradeOpsReplay.test.js (fixture ../fixtures/trade_ops_replay.json.gz).

Exchanges: backend/tests/exchanges/py/harness.py's fakes (pybit `requests.Session.send` + every trader's
aiohttp session replaced, fake clock that only advances on sleeps, killswitch / plan gate / metrics /
trade_events stubbed). Per step a fresh Router serves the step's routes and records every request the
bot's traders sent (method, URL as on the wire, auth headers, body), its sleeps and log markers.

Every step also carries the site's D15 permission answer (bybit /v5/user/query-api, bingx
/openApi/v1/account/apiPermissions, binance /sapi/v1/account/apiRestrictions, okx /api/v5/account/config):
the bot never asks (it stores any key that tests OK), the site does after a successful test. `d15_wire`
records, with the bot's own signing code (pybit get_api_key_information, bingx/okx `_request`, binance
`_build_query`), the exact request each exchange's permission read is.

Auth: miniapp_api._tg_user reads the test header X-Test-Uid; everything after auth runs unchanged.
time.time is pinned per step (the traders run on the harness clock that starts at the same value).

  cd /home/user/MAIN_BOT/CHM_BREAKER_V4
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> -I -B <site>/backend/tests/autotrade/ops/py/drive_trade_ops.py [OUT]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import asyncio
import gzip
import json
import logging
import os
import sqlite3
import sys
import tempfile
import time as _time
import types

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
HERE = os.path.dirname(os.path.abspath(__file__))
SITE_BACKEND = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
EXPY = os.path.join(SITE_BACKEND, "tests", "exchanges", "py")
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "..", "fixtures", "trade_ops_replay.json.gz")
TMP = tempfile.mkdtemp(prefix="m13b_ops_")
DBP = os.path.join(TMP, "bot.db")
os.environ["DB_PATH"] = DBP
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
# db_upsert_user encrypts keys with Fernet and hard-stops without a key once any key exists (test-only key)
os.environ["BYBIT_FERNET_KEY"] = "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="
sys.dont_write_bytecode = True
os.chdir(BOT)
sys.path.insert(0, BOT)
sys.path.insert(0, EXPY)

NOW = 1767225600.0 + 10 * 3600 + 0.25      # 2026-01-01 10:00:00.25 UTC
CLOCK = [NOW]
_time.time = lambda: CLOCK[0]

print("[stage] import harness", file=sys.stderr, flush=True) if os.environ.get("DRIVE_VERBOSE") else None
import harness  # noqa: E402  (imports the four traders, pybit, killswitch, plan gate …)
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import database  # noqa: E402
import cache  # noqa: E402
import miniapp_api as api  # noqa: E402
import quick_close  # noqa: E402
from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestServer  # noqa: E402
from user_manager import UserManager  # noqa: E402
import handlers.trading as h_trading  # noqa: E402
import handlers.quick_close as h_qc  # noqa: E402
import handlers._common as h_common  # noqa: E402
from i18n import MESSAGES as I18N  # noqa: E402

by, bx, bn, ok = harness.by, harness.bx, harness.bn, harness.ok

# ── keys and users ───────────────────────────────────────────────────────────
K = {
    "bybit": ("BYBITKEY123456789", "bybit-secret-xyz-0001", ""),
    "bingx": ("BXKEY-abc123456", "bx-secret-4567890", ""),
    "binance": ("BNKEY-abc1234567", "bn-secret-4567890", ""),
    "okx": ("OKKEY-abc1234567", "ok-secret-4567890", "Pass-phrase#1"),
}
D = 86400
USERS = [  # uid, sub_plan, sub_status, sub_expires (rel), lang, extra fields, keys {ex: (key, secret, pp)}
    (201, "pro", "active", 30 * D, "ru", {}, {}),
    (202, "free", "active", 0, "ru", {}, {}),
    (203, "pro", "active", 30 * D, "en", {}, {}),
    (204, "pro", "active", 30 * D, "ru", {"trade_exchange": "bybit", "auto_trade": True, "trade_risk_pct": 1.0, "trade_leverage": 10,
                                          "max_trades_limit": 0}, {"bybit": K["bybit"]}),
    (205, "pro", "active", 30 * D, "ru", {"trade_exchange": "bingx", "auto_trade": True}, {"bingx": K["bingx"]}),
    (206, "pro", "active", 30 * D, "en", {"trade_exchange": "binance", "auto_trade": True}, {"binance": K["binance"]}),
    (207, "pro", "active", 30 * D, "ru", {"trade_exchange": "okx", "auto_trade": True}, {"okx": K["okx"]}),
    (208, "pro", "active", 30 * D, "ru", {"trade_exchange": "okx", "auto_trade": True}, {"okx": (K["okx"][0], K["okx"][1], "")}),
    (209, "pro", "active", 30 * D, "ru", {"trade_exchange": "kraken", "auto_trade": True}, {"bybit": K["bybit"]}),
    (210, "pro", "active", 30 * D, "ru", {"trade_exchange": "bybit", "bybit_demo": True, "auto_trade": True}, {"bybit": K["bybit"]}),
    (211, "pro", "active", -3 * D, "ru", {"trade_exchange": "bybit"}, {"bybit": K["bybit"]}),
    (212, "pro", "banned", 30 * D, "ru", {"trade_exchange": "bybit"}, {"bybit": K["bybit"]}),
    (213, "pro", "active", 30 * D, "ru", {"trade_exchange": "okx"}, {}),
    (214, "pro", "active", 30 * D, "ru", {"trade_exchange": "bybit", "max_trades_limit": 1}, {"bybit": K["bybit"]}),
    (215, "pro", "active", 30 * D, "ru", {"trade_exchange": "bybit", "hold_lock_enabled": True, "hold_lock_min_rr": 0.5},
     {"bybit": K["bybit"], "okx": K["okx"]}),
    (216, "pro", "active", 30 * D, "en", {"trade_exchange": "bybit", "hold_lock_enabled": True, "hold_lock_min_rr": 0.0}, {"bybit": K["bybit"]}),
    (217, "pro", "active", 30 * D, "ru", {"trade_exchange": "bingx"},
     {"bybit": K["bybit"], "bingx": K["bingx"], "binance": K["binance"], "okx": K["okx"]}),
    (218, "pro", "active", 30 * D, "ru", {"trade_exchange": ""}, {"bybit": K["bybit"]}),
    (219, "pro", "active", 30 * D, "ru", {"trade_exchange": "bybit", "auto_trade": True}, {"bybit": K["bybit"]}),
    (223, "pro", "active", 30 * D, "ru", {"trade_exchange": "kraken", "auto_trade": True}, {"bybit": K["bybit"]}),
    (224, "pro", "active", 30 * D, "ru", {"trade_exchange": "", "auto_trade": True}, {"bybit": K["bybit"], "okx": K["okx"]}),
    (225, "pro", "active", 30 * D, "ru", {"trade_exchange": "bybit", "auto_trade": True}, {}),
    (220, "pro", "active", 30 * D, "ru", {"trade_exchange": "bingx", "auto_trade": True}, {"bingx": K["bingx"]}),
    (221, "pro", "active", 30 * D, "en", {"trade_exchange": "binance", "auto_trade": True}, {"binance": K["binance"]}),
    (222, "pro", "active", 30 * D, "ru", {"trade_exchange": "okx", "auto_trade": True}, {"okx": K["okx"]}),
    (123, "free", "active", 0, "ru", {}, {}),
]

# ── trades ───────────────────────────────────────────────────────────────────
TRADE_COLS = ["trade_id", "user_id", "symbol", "direction", "entry", "sl", "tp1", "tp2", "tp3", "created_at", "strategy",
              "breakout_type", "timeframe", "result", "result_rr", "order_id", "pos_idx", "tp_placed", "be_set", "qty",
              "entry_lo", "entry_hi", "exchange", "state", "original_sl", "progress_stage"]
EXEC_BTN = "exec"
QC_BTNS = "qc"


def T(tid, uid, sym="BTC-USDT-SWAP", direction="LONG", entry=87000.5, sl=86000.0, tp1=88500.0, tp2=89500.0, tp3=90500.0,
      card=EXEC_BTN, age=3600, **kw):
    r = {"trade_id": tid, "user_id": uid, "symbol": sym, "direction": direction, "entry": entry, "sl": sl, "tp1": tp1,
         "tp2": tp2, "tp3": tp3, "created_at": NOW - age, "strategy": kw.pop("strategy", "LEVELS"),
         "breakout_type": kw.pop("breakout_type", ""), "timeframe": "1h", "result": "", "result_rr": 0.0, "order_id": "",
         "pos_idx": 0, "tp_placed": 0, "be_set": 0, "qty": 0.0, "entry_lo": 0.0, "entry_hi": 0.0, "exchange": "bybit",
         "state": "PENDING", "original_sl": sl}
    r.update(kw)
    r["_card"] = card
    return r


TRADES = [
    # exec on every exchange
    T("ex-by-1", 204), T("ex-by-fail", 204, sym="ETH-USDT-SWAP", direction="SHORT", entry=3000.0, sl=3060.0, tp1=2900.0, tp2=0.0, tp3=0.0),
    T("ex-by-split", 204, sym="SOL-USDT-SWAP", entry=150.0, sl=145.0, tp1=160.0, tp2=0.0, tp3=0.0, breakout_type="SMC", strategy="SMC",
      entry_lo=149.0, entry_hi=151.0),
    T("ex-bx-1", 205), T("ex-bx-fail", 205, sym="ETH-USDT-SWAP", direction="SHORT", entry=3000.0, sl=3060.0, tp1=2900.0, tp2=0.0, tp3=0.0),
    T("ex-bn-1", 206), T("ex-bn-fail", 206, sym="ETH-USDT-SWAP"),
    T("ex-ok-1", 207), T("ex-ok-fail", 207, sym="ETH-USDT-SWAP"),
    T("ex-ok-nopp", 208), T("ex-kr-1", 209), T("ex-demo-1", 210),
    T("ex-expired", 211), T("ex-banned", 212), T("ex-nokeys", 225), T("ex-okx-nokeys", 213), T("ex-empty-ex", 218),
    T("ex-res", 204, result="TP1", result_rr=1.5), T("ex-oid", 204, sym="BNB-USDT-SWAP", order_id="ord-5"),
    T("ex-lim-a", 214, sym="XRP-USDT-SWAP", order_id="ord-a"), T("ex-lim-b", 214, sym="DOGE-USDT-SWAP"),
    T("ex-dup-a", 204, sym="ADA-USDT-SWAP", order_id="ord-dup"), T("ex-dup-b", 204, sym="ADA-USDT-SWAP"),
    T("ex-tp2-str", 204, sym="LINK-USDT-SWAP", tp2="abc"), T("ex-entry-str", 204, sym="AVAX-USDT-SWAP", entry_lo="abc"),
    T("ex-locked", 204, sym="DOT-USDT-SWAP"),
    T("ex-foreign", 205, sym="LTC-USDT-SWAP"),          # 204 presses 205's button: the bot opens it with 204's keys
    T("ex-nobtn", 204, sym="NEAR-USDT-SWAP", card=None),
    # [EXEC-STALE-GUARD 2026-10]: the tracker's outcome / the tracker horizon
    T("ex-st-sl", 204, sym="FIL-USDT-SWAP", progress_stage="SL"),
    T("ex-st-tp1", 204, sym="FIL-USDT-SWAP", progress_stage="TP1"),
    T("ex-st-missed", 204, sym="FIL-USDT-SWAP", progress_stage="MISSED"),
    T("ex-st-expired", 204, sym="FIL-USDT-SWAP", progress_stage="EXPIRED"),
    T("ex-st-old", 204, sym="FIL-USDT-SWAP", age=72 * 3600 + 120),
    T("ex-st-entry", 204, sym="APT-USDT-SWAP", progress_stage="ENTRY"),
    # quick close
    T("qc-by-1", 219, order_id="ord-q1", state="OPEN", card=QC_BTNS, pos_idx=0),
    T("qc-by-short", 219, sym="ETH-USDT-SWAP", direction="SHORT", entry=3000.0, sl=3060.0, tp1=2900.0, order_id="ord-q2",
      state="OPEN", card=QC_BTNS, pos_idx=2),
    T("qc-bx-1", 220, exchange="bingx", order_id="ord-q3", state="OPEN", card=QC_BTNS),
    T("qc-bn-1", 221, exchange="binance", order_id="ord-q4", state="OPEN", card=QC_BTNS),
    T("qc-ok-1", 222, exchange="okx", order_id="ord-q5", state="OPEN", card=QC_BTNS),
    T("qc-ok-short", 222, sym="ETH-USDT-SWAP", direction="SHORT", entry=3000.0, sl=3060.0, tp1=2900.0, exchange="okx",
      order_id="ord-q6", state="OPEN", card=QC_BTNS),
    T("qc-kraken", 219, exchange="kraken", order_id="ord-q7", state="OPEN", card=QC_BTNS),
    T("qc-smc-null-ex", 222, exchange=None, order_id="ord-q8", state="OPEN", card=QC_BTNS),   # SMC rows: default exchange
    T("qc-closed", 219, result="TP1", result_rr=1.5, order_id="ord-q9", state="CLOSED", card=QC_BTNS),
    T("qc-entry0", 219, entry=0.0, order_id="ord-q10", state="OPEN", card=QC_BTNS),
    T("qc-posidx-null", 219, pos_idx=None, order_id="ord-q11", state="OPEN", card=QC_BTNS),
    T("qc-hold", 215, sym="ETH-USDT-SWAP", entry=3000.0, sl=2940.0, tp1=3100.0, order_id="ord-q12", state="OPEN", card=QC_BTNS),
    T("qc-hold-nocache", 215, sym="NOCACHE-USDT-SWAP", order_id="ord-q13", state="OPEN", card=QC_BTNS),
    T("qc-hold-okx", 215, exchange="okx", order_id="ord-q14", state="OPEN", card=QC_BTNS),
    T("qc-hold0", 216, sym="ETH-USDT-SWAP", entry=3000.0, sl=2940.0, tp1=3100.0, order_id="ord-q15", state="OPEN", card=QC_BTNS),
    T("qc-nobtn", 219, sym="TRX-USDT-SWAP", order_id="ord-q16", state="OPEN", card=EXEC_BTN),
    T("qc-217-by", 217, exchange="bybit", order_id="ord-q17", state="OPEN", card=QC_BTNS),
    T("qc-dir-empty", 219, direction="", order_id="ord-q18", state="OPEN", card=QC_BTNS),
    # progress
    T("pr-long", 219, sym="BTC-USDT-SWAP", age=45 * 60, card=QC_BTNS),
    T("pr-short", 219, sym="ETH-USDT-SWAP", direction="SHORT", entry=3000.0, sl=3060.0, tp1=2900.0, age=125 * 60, card=QC_BTNS),
    T("pr-nosl", 219, sym="BTC-USDT-SWAP", sl=0.0, tp1=0.0, age=59 * 60, card=QC_BTNS),
    T("pr-nodata", 219, sym="NOCACHE-USDT-SWAP", card=QC_BTNS),
    T("pr-closed", 219, sym="BTC-USDT-SWAP", result="SL", result_rr=-1.0, card=QC_BTNS),
    T("pr-future", 219, sym="BTC-USDT-SWAP", age=-300, card=QC_BTNS),
    T("pr-5m", 219, sym="SOL-USDT-SWAP", entry=150.0, sl=145.0, tp1=160.0, card=QC_BTNS),
    T("pr-entry0", 219, entry=0.0, card=QC_BTNS),
    T("a/b", 219, sym="BTC-USDT-SWAP", card=QC_BTNS),
    T("тест-1", 219, sym="BTC-USDT-SWAP", card=QC_BTNS),
]

# candle cache (the bot's cache.get_candles; the site's engine cache): last closes per (symbol, tf)
CANDLES = {
    ("BTC-USDT-SWAP", "15m"): 87650.25,
    ("ETH-USDT-SWAP", "15m"): 2987.5,
    ("SOL-USDT-SWAP", "5m"): 148.125,
    ("SOL-USDT-SWAP", "15m"): 151.0,
}


def bars_for(close, n=40, tf_ms=900_000):
    t0 = int(NOW * 1000) // tf_ms * tf_ms - n * tf_ms
    out = []
    for i in range(n):
        c = close * (1 + (i - n) * 0.0001)
        if i == n - 1:
            c = close
        out.append([t0 + i * tf_ms, c * 0.999, c * 1.002, c * 0.997, c, 100.0 + i])
    return out


def to_df(bars):
    arr = np.array(bars, dtype=float)
    idx = pd.to_datetime(arr[:, 0].astype("int64"), unit="ms")
    df = pd.DataFrame({"open": arr[:, 1], "high": arr[:, 2], "low": arr[:, 3], "close": arr[:, 4], "volume": arr[:, 5]}, index=idx)
    df.index.name = "open_time"
    return df


# ── exchange responses (shapes of tests/exchanges/py/scen_*.py) ──────────────
def R(method, path, *resps, query=None):
    def spec(x):
        if isinstance(x, dict) and ("raise" in x or "json" in x or "text" in x or isinstance(x.get("status"), int)):
            return x
        return {"json": x}
    r = {"method": method, "path": path, "responses": [spec(x) for x in resps]}
    if query:
        r["query"] = query
    return r


BY_T = {"retCode": 0, "retMsg": "OK", "result": {"timeSecond": str(int(NOW)), "timeNano": str(int(NOW)) + "250000000"}}


def by_wallet(total="1000.5", avail="800.25", coin_avail=""):
    return {"retCode": 0, "retMsg": "OK", "result": {"list": [{
        "totalEquity": total, "totalAvailableBalance": avail, "totalWalletBalance": total, "totalUnrealisedPnl": "1.5",
        "coin": [{"coin": "USDT", "walletBalance": total, "equity": total, "availableBalance": coin_avail, "availableToWithdraw": ""}]}]}}


def by_err(code, msg):
    return {"retCode": code, "retMsg": msg, "result": {}}


def by_instr(step="0.001", tick="0.1"):
    return {"retCode": 0, "retMsg": "OK", "result": {"list": [{"lotSizeFilter": {"qtyStep": step}, "priceFilter": {"tickSize": tick}}]}}


def by_order(oid):
    return {"retCode": 0, "retMsg": "OK", "result": {"orderId": oid, "orderLinkId": ""}}


def by_pos(rows):
    return {"retCode": 0, "retMsg": "OK", "result": {"list": rows}}


def by_p(sym="BTCUSDT", size="0.012", idx=0, avg="87000.5", side="Buy", **kw):
    d = {"symbol": sym, "side": side, "size": size, "positionIdx": idx, "avgPrice": avg, "markPrice": avg, "stopLoss": ""}
    d.update(kw)
    return d


BY_OK = {"retCode": 0, "retMsg": "OK", "result": {}}
BY_BASE = [R("GET", "/v5/market/time", BY_T), R("POST", "/v5/position/switch-isolated", by_err(110026, "Cross/isolated margin mode is not modified")),
           R("POST", "/v5/position/set-leverage", by_err(110043, "leverage not modified")),
           R("GET", "/v5/account/wallet-balance", by_wallet()), R("GET", "/v5/market/instruments-info", by_instr())]
BY_TICK = {"retCode": 0, "retMsg": "OK", "result": {"list": [{"symbol": "BTCUSDT", "markPrice": "87500.0", "lastPrice": "87500.0",
                                                            "bid1Price": "87499.5", "ask1Price": "87500.5", "fundingRate": "0.0001"}]}}
BX_CONTRACTS = {"code": 0, "msg": "", "data": [
    {"symbol": "BTC-USDT", "tradeMinQuantity": 0.0001, "pricePrecision": 1, "maxLeverage": 125, "status": 1},
    {"symbol": "ETH-USDT", "tradeMinQuantity": 0.01, "pricePrecision": 2, "maxLeverage": 100, "status": 1}]}


def bx_bal(eq="1000.5"):
    return {"code": 0, "msg": "", "data": {"balance": {"userId": "1", "asset": "USDT", "balance": "1000.0", "equity": eq,
                                                       "unrealizedProfit": "0.5", "availableMargin": "900.0"}}}


def bx_err(code, msg):
    return {"code": code, "msg": msg, "data": {}}


def bx_order(oid):
    return {"code": 0, "msg": "", "data": {"order": {"orderId": oid, "symbol": "BTC-USDT", "side": "BUY", "type": "LIMIT"}}}


def bx_pos(sym="BTC-USDT", amt="0.0115", side="LONG", lev=10, avg="87000.5"):
    return {"code": 0, "msg": "", "data": [{"symbol": sym, "positionSide": side, "positionAmt": amt, "avgPrice": avg,
                                            "markPrice": avg, "unrealizedProfit": "0.12", "leverage": lev, "stopLoss": ""}]}


def bx_oo(*orders):
    return {"code": 0, "msg": "", "data": {"orders": list(orders)}}


BN_INFO = {"symbols": [
    {"symbol": "BTCUSDT", "status": "TRADING", "filters": [{"filterType": "LOT_SIZE", "stepSize": "0.001"}, {"filterType": "PRICE_FILTER", "tickSize": "0.10"}]},
    {"symbol": "ETHUSDT", "status": "TRADING", "filters": [{"filterType": "LOT_SIZE", "stepSize": "0.001"}, {"filterType": "PRICE_FILTER", "tickSize": "0.01"}]}]}


def bn_bal(b="1000.50"):
    return [{"asset": "USDT", "balance": b, "availableBalance": b, "crossUnPnl": "0.75"}]


def bn_err(code, msg):
    return {"code": code, "msg": msg}


def bn_order(oid=283194212, **kw):
    d = {"orderId": oid, "symbol": "BTCUSDT", "status": "NEW", "clientOrderId": "x", "price": "0", "avgPrice": "0", "origQty": "0.011"}
    d.update(kw)
    return d


def bn_pos(amt="0.011", side="LONG", sym="BTCUSDT", lev="10", **kw):
    d = {"symbol": sym, "positionAmt": amt, "entryPrice": "87000.5", "markPrice": "87010.0", "unRealizedProfit": "0.1",
         "leverage": lev, "positionSide": side}
    d.update(kw)
    return [d]


def ok_ok(*data):
    return {"code": "0", "msg": "", "data": list(data)}


def ok_err(code, msg, data=None):
    return {"code": code, "msg": msg, "data": data if data is not None else []}


def ok_inst(inst_id="BTC-USDT-SWAP", lot="0.01", tick="0.1", lever="125", ct="0.01"):
    return ok_ok({"instType": "SWAP", "instId": inst_id, "ctType": "linear", "ctValCcy": inst_id.split("-")[0], "lotSz": lot,
                  "tickSz": tick, "lever": lever, "minSz": lot, "state": "live", "ctVal": ct})


OK_BAL = ok_ok({"totalEq": "1000.5", "upl": "1.25", "details": [{"ccy": "USDT", "eq": "990.5", "cashBal": "980", "availBal": "900.1"}]})
OK_LEV = ok_ok({"instId": "BTC-USDT-SWAP", "lever": "10", "mgnMode": "cross", "posSide": ""})
OK_ORDER = ok_ok({"ordId": "312269865356374016", "clOrdId": "", "tag": "", "sCode": "0", "sMsg": "Order placed"})


def ok_pos(inst_id="BTC-USDT-SWAP", p="1", side="long"):
    return ok_ok({"instId": inst_id, "posSide": side, "pos": p, "avgPx": "87000.5", "markPx": "87010.1", "upl": "0.1", "lever": "10",
                  "liqPx": "70000"})


# D15 answers (the site reads them; the bot never asks)
D15 = {
    "bybit": {
        "ok": {"retCode": 0, "retMsg": "", "result": {"id": "13770661", "note": "chm", "apiKey": "x", "readOnly": 0, "secret": "",
                                                       "permissions": {"ContractTrade": ["Order", "Position"], "Spot": [], "Wallet": ["AccountTransfer"],
                                                                       "Options": [], "Derivatives": ["DerivativesTrade"], "CopyTrading": [],
                                                                       "BlockTrade": [], "Exchange": [], "NFT": [], "Affiliate": []},
                                                       "ips": ["*"], "type": 1, "deadlineDay": 66, "unified": 0, "uta": 1, "userID": 24617703,
                                                       "isMaster": True, "parentUid": "0"}, "retExtInfo": {}, "time": int(NOW * 1000)},
        "withdraw": {"retCode": 0, "retMsg": "", "result": {"id": "1", "readOnly": 0, "permissions": {
            "ContractTrade": ["Order", "Position"], "Wallet": ["AccountTransfer", "SubMemberTransfer", "Withdraw"]}}, "retExtInfo": {}},
        "unknown": {"retCode": 10005, "retMsg": "Permission denied, please check your API key permissions.", "result": {}},
    },
    "bingx": {
        "ok": {"code": 0, "msg": "", "debugMsg": "", "data": {"apiKey": "x", "permissions": [1, 2, 3], "ipAddresses": [], "note": "chm"}},
        "withdraw": {"code": 0, "msg": "", "debugMsg": "", "data": {"apiKey": "x", "permissions": [2, 3, 5], "ipAddresses": []}},
        "unknown": {"code": 100413, "msg": "Incorrect apiKey", "data": {}},
    },
    "binance": {
        "ok": {"ipRestrict": False, "createTime": 1767225600000, "enableReading": True, "enableWithdrawals": False,
               "enableInternalTransfer": False, "enableMargin": False, "enableFutures": True, "permitsUniversalTransfer": False,
               "enableVanillaOptions": False, "enableFixApiTrade": False, "enableFixReadOnly": False,
               "enableSpotAndMarginTrading": False, "enablePortfolioMarginTrading": False},
        "withdraw": {"ipRestrict": True, "createTime": 1767225600000, "enableReading": True, "enableWithdrawals": True, "enableFutures": True},
        "unknown": {"code": -2015, "msg": "Invalid API-key, IP, or permissions for action."},
    },
    "okx": {
        "ok": ok_ok({"uid": "44705892343619584", "mainUid": "44705892343619584", "acctLv": "2", "posMode": "long_short_mode",
                     "autoLoan": False, "greeksType": "PA", "level": "Lv1", "ctIsoMode": "automatic", "mgnIsoMode": "automatic",
                     "roleType": "0", "opAuth": "0", "kycLv": "1", "label": "chm", "ip": "", "perm": "read_only,trade"}),
        "withdraw": ok_ok({"uid": "1", "acctLv": "2", "posMode": "net_mode", "label": "x", "ip": "", "perm": "read_only,withdraw,trade"}),
        "unknown": ok_err("50113", "Invalid Sign"),
    },
}
D15_PATH = {"bybit": "/v5/user/query-api", "bingx": "/openApi/v1/account/apiPermissions",
            "binance": "/sapi/v1/account/apiRestrictions", "okx": "/api/v5/account/config"}


def d15_route(ex, kind):
    return R("GET", D15_PATH[ex], D15[ex][kind])


def test_routes(ex, mode="ok"):
    """The responses test_connection reads (and the D15 read after it)."""
    if ex == "bybit":
        if mode == "ok":
            return [R("GET", "/v5/market/time", BY_T), R("GET", "/v5/account/wallet-balance", by_wallet("500", "400", "450.5"))]
        if mode == "switch":
            return [R("GET", "/v5/market/time", BY_T),
                    R("GET", "/v5/account/wallet-balance", by_err(10003, "API key is invalid."), by_err(10003, "API key is invalid."),
                      by_wallet("900", "800", "850"))]
        if mode == "fail":
            return [R("GET", "/v5/market/time", BY_T), R("GET", "/v5/account/wallet-balance", by_err(10003, "API key is invalid."))]
        return [R("GET", "/v5/market/time", {"status": 502, "text": "bad gateway", "headers": {"Content-Type": "text/html"}})]
    if ex == "bingx":
        if mode == "ok":
            return [R("GET", "/openApi/swap/v2/user/balance", bx_bal("777.125"))]
        return [R("GET", "/openApi/swap/v2/user/balance", bx_err(100413, "Incorrect apiKey")),
                R("GET", "/openApi/swap/v1/user/balance", bx_err(100413, "Incorrect apiKey"))]
    if ex == "binance":
        if mode == "ok":
            return [R("GET", "/fapi/v2/balance", bn_bal("1234.5678"))]
        return [R("GET", "/fapi/v2/balance", bn_err(-2015, "Invalid API-key, IP, or permissions for action."))]
    if mode == "ok":
        return [R("GET", "/api/v5/account/balance", OK_BAL)]
    return [R("GET", "/api/v5/account/balance", ok_err("50111", "Invalid OK-ACCESS-KEY"))]


# ── steps ────────────────────────────────────────────────────────────────────
STEPS: list = []
TT = [NOW]
B = "/miniapp/api"
J = json.dumps


def http(name, uid, method, path, body=None, *, routes=None, d15=None, dt=31.0, ctype="application/json", timeout=None, ex_d15=None):
    TT[0] += dt
    STEPS.append({"name": name, "kind": "http", "uid": uid, "method": method, "path": path, "body": body, "ctype": ctype,
                  "now": TT[0], "routes": routes or [], "d15": d15, "d15_ex": ex_d15, "force_timeout": timeout})


def cb(name, uid, handler, data, tid=None, *, routes=None, dt=5.0, pre_lock=False, site=None):
    TT[0] += dt
    STEPS.append({"name": name, "kind": "cb", "uid": uid, "handler": handler, "data": data, "tid": tid, "now": TT[0],
                  "routes": routes or [], "pre_lock": pre_lock, "site": site})


# exchange/keys
http("keys unauth", None, "POST", B + "/exchange/keys", J({"exchange": "bybit"}))
http("keys free → pro_required", 202, "POST", B + "/exchange/keys", J({"exchange": "bybit", "api_key": "k" * 12, "api_secret": "s" * 12}))
http("keys bad exchange missing", 201, "POST", B + "/exchange/keys", J({"api_key": "k" * 12}))
http("keys rate limited (same 30 s)", 201, "POST", B + "/exchange/keys", J({"exchange": "bybit"}), dt=10)
for body in [J({"exchange": "kraken"}), J({"exchange": ["bybit"]}), J({"exchange": 5}), J({"exchange": None}), "not json", J([1, 2]),
             J({"exchange": "bybіt"}), J({"exchange": " BYBIT ", "api_key": "short", "api_secret": "s" * 12}),
             J({"exchange": "bybit", "api_key": "k" * 9 + " ", "api_secret": "s" * 12}),
             J({"exchange": "bybit", "api_key": "k" * 10, "api_secret": " " + "s" * 9}),
             J({"exchange": "bybit", "api_key": 12345678901, "api_secret": False}),
             J({"exchange": "bingx", "api_key": ["k" * 12], "api_secret": "s" * 12}),
             J({"exchange": "okx", "api_key": "k" * 12, "api_secret": "s" * 12, "passphrase": " abc "}),
             J({"exchange": "okx", "api_key": "k" * 12, "api_secret": "s" * 12})]:
    http(f"keys validation {body[:60]}", 201, "POST", B + "/exchange/keys", body)
# successes / failures per exchange, with the D15 answer the site will see
for ex, uid in (("bybit", 201), ("bingx", 201), ("binance", 203), ("okx", 203)):
    key, sec, pp = K[ex]
    body = {"exchange": ex, "api_key": f"  {key}  ", "api_secret": sec}
    if ex == "okx":
        body["passphrase"] = pp
    http(f"keys {ex} test fails", uid, "POST", B + "/exchange/keys", J(body), routes=test_routes(ex, "fail") + [d15_route(ex, "ok")], d15="ok", ex_d15=ex)
    http(f"keys {ex} ok + D15 withdraw", uid, "POST", B + "/exchange/keys", J(body), routes=test_routes(ex, "ok") + [d15_route(ex, "withdraw")],
         d15="withdraw", ex_d15=ex)
    http(f"keys {ex} ok + D15 unreadable", uid, "POST", B + "/exchange/keys", J(body), routes=test_routes(ex, "ok") + [d15_route(ex, "unknown")],
         d15="unknown", ex_d15=ex)
    http(f"keys {ex} ok + D15 ok → saved", uid, "POST", B + "/exchange/keys", J(body), routes=test_routes(ex, "ok") + [d15_route(ex, "ok")],
         d15="ok", ex_d15=ex)
http("keys okx bad keys: test passes with balance 0, D15 read rejected", 203, "POST", B + "/exchange/keys",
     J({"exchange": "okx", "api_key": "OKBAD-0000000000", "api_secret": "nope-000000000", "passphrase": "wrong"}),
     routes=test_routes("okx", "fail") + [d15_route("okx", "unknown")], d15="unknown", ex_d15="okx")
http("keys bybit demo switch", 203, "POST", B + "/exchange/keys", J({"exchange": "bybit", "api_key": K["bybit"][0], "api_secret": K["bybit"][1]}),
     routes=test_routes("bybit", "switch") + [d15_route("bybit", "ok")], d15="ok", ex_d15="bybit")
http("keys bybit host down", 203, "POST", B + "/exchange/keys", J({"exchange": "bybit", "api_key": K["bybit"][0], "api_secret": K["bybit"][1]}),
     routes=test_routes("bybit", "down") + [d15_route("bybit", "ok")], d15="ok", ex_d15="bybit")
http("keys bybit on demo user (demo first)", 210, "POST", B + "/exchange/keys", J({"exchange": "bybit", "api_key": K["bybit"][0], "api_secret": K["bybit"][1]}),
     routes=test_routes("bybit", "ok") + [d15_route("bybit", "ok")], d15="ok", ex_d15="bybit")
http("keys timeout", 205, "POST", B + "/exchange/keys", J({"exchange": "bingx", "api_key": K["bingx"][0], "api_secret": K["bingx"][1]}),
     routes=test_routes("bingx", "ok") + [d15_route("bingx", "ok")], d15="ok", ex_d15="bingx", timeout="test")
http("keys admin on free plan", 123, "POST", B + "/exchange/keys", J({"exchange": "binance", "api_key": K["binance"][0], "api_secret": K["binance"][1]}),
     routes=test_routes("binance", "ok") + [d15_route("binance", "ok")], d15="ok", ex_d15="binance")
http("keys expired pro (can() reads sub_plan only)", 211, "POST", B + "/exchange/keys",
     J({"exchange": "bingx", "api_key": K["bingx"][0], "api_secret": K["bingx"][1]}),
     routes=test_routes("bingx", "ok") + [d15_route("bingx", "ok")], d15="ok", ex_d15="bingx")
# exchange/keys/remove
for uid, body in ((201, J({"exchange": "kraken"})), (201, J({})), (201, "x"), (201, J({"exchange": " OKX "})), (217, J({"exchange": "bybit"})),
                  (217, J({"exchange": "bingx"})), (223, J({"exchange": "bybit"})), (202, J({"exchange": "binance"})),
                  (224, J({"exchange": "bybit"})), (224, J({"exchange": "OKX"}))):
    http(f"remove {uid} {body[:40]}", uid, "POST", B + "/exchange/keys/remove", body)
http("remove unauth", None, "POST", B + "/exchange/keys/remove", J({"exchange": "bybit"}))

# positions
POS_BY = by_pos([by_p(), by_p("ETHUSDT", "1.5", 2, "3000.5", "Sell", markPrice="2990.25", unrealisedPnl="14.6125", leverage="20"),
                 by_p("1000PEPEUSDT", "3409000", 0, "0.00391", "Sell", markPrice="0.00401", unrealisedPnl="-34.09", leverage="5"),
                 by_p("SOLUSDT", "0", 0, "150", "Buy"),
                 by_p("XRPUSDT", "100", 0, "abc", "Buy", entryPrice="2.5"),
                 by_p("DOGEUSDT", "10", 0, "0.2", "Buy", leverage="inf"),
                 by_p("ADAUSDT", "10", 0, "0.5", "Buy", leverage="x", markPrice="0.55", unrealisedPnl="0.5")])
DASH_BY = [R("GET", "/v5/market/time", BY_T), R("GET", "/v5/position/list", POS_BY),
           R("GET", "/v5/order/realtime", {"retCode": 0, "result": {"list": [{"orderId": "o1"}, {"orderId": "o2"}]}}),
           R("GET", "/v5/account/wallet-balance", by_wallet()),
           R("GET", "/v5/position/closed-pnl", {"retCode": 0, "result": {"list": [{"closedPnl": "1.25"}]}})]
DASH_BX = [R("GET", "/openApi/swap/v2/user/positions", {"code": 0, "msg": "", "data": [
    {"symbol": "BTC-USDT", "positionSide": "LONG", "positionAmt": "0.5", "avgPrice": "87000", "markPrice": "87100", "unrealizedProfit": "50", "leverage": 10},
    {"symbol": "SOL-USDT", "positionSide": "BOTH", "positionAmt": "-3", "avgPrice": "150", "markPrice": "149", "leverage": "5"}]}),
    R("GET", "/openApi/swap/v2/trade/openOrders", bx_oo({"orderId": 1, "symbol": "BTC-USDT", "side": "SELL", "type": "LIMIT", "price": "88000", "origQty": "0.1"})),
    R("GET", "/openApi/swap/v2/user/balance", bx_bal()),
    R("GET", "/openApi/swap/v2/trade/allFillOrders", {"code": 0, "msg": "", "data": {"fill_orders": [{"profit": "1.1"}]}})]
DASH_BN = [R("GET", "/fapi/v2/positionRisk", [
    {"symbol": "BTCUSDT", "positionAmt": "0.011", "entryPrice": "87000.5", "markPrice": "87010.0", "unRealizedProfit": "0.1045", "leverage": "10", "positionSide": "BOTH"},
    {"symbol": "ETHUSDT", "positionAmt": "-1.2", "entryPrice": "3000", "markPrice": "3010", "unRealizedProfit": "-12", "leverage": "3", "positionSide": "SHORT"}]),
    R("GET", "/fapi/v1/openOrders", [{"orderId": 1, "symbol": "BTCUSDT", "side": "SELL", "type": "LIMIT", "price": "88000", "origQty": "0.011", "stopPrice": "0"}]),
    R("GET", "/fapi/v2/balance", bn_bal()), R("GET", "/fapi/v1/income", [{"income": "1.5"}, {"income": "-0.25"}])]
DASH_OK = [R("GET", "/api/v5/account/balance", OK_BAL), R("GET", "/api/v5/account/positions", ok_pos())]
http("positions unauth", None, "GET", B + "/positions", dt=2)
http("positions no keys", 225, "GET", B + "/positions", dt=2)
http("positions bybit", 204, "GET", B + "/positions", routes=DASH_BY, dt=2)
http("positions bybit demo user", 210, "GET", B + "/positions", routes=DASH_BY, dt=2)
http("positions bingx", 205, "GET", B + "/positions", routes=DASH_BX, dt=2)
http("positions binance", 206, "GET", B + "/positions", routes=DASH_BN, dt=2)
http("positions okx (3-way unpack of a 2-tuple)", 207, "GET", B + "/positions", routes=DASH_OK, dt=2)
http("positions okx no passphrase", 208, "GET", B + "/positions", dt=2)
http("positions invalid exchange → bybit", 209, "GET", B + "/positions", routes=DASH_BY, dt=2)
http("positions empty trade_exchange → bybit", 218, "GET", B + "/positions", routes=DASH_BY, dt=2)
http("positions dashboard timeout", 205, "GET", B + "/positions", routes=DASH_BX, dt=2, timeout="dashboard")
http("positions bybit all reads fail", 204, "GET", B + "/positions", dt=2,
     routes=[R("GET", "/v5/market/time", BY_T), R("GET", "/v5/position/list", by_err(10003, "x")), R("GET", "/v5/order/realtime", by_err(10003, "x")),
             R("GET", "/v5/account/wallet-balance", by_err(10003, "x")), R("GET", "/v5/position/closed-pnl", by_err(10003, "x"))])
for i in range(7):
    http(f"positions burst {i}", 217, "GET", B + "/positions", routes=DASH_BX, dt=1)
for m, p in (("POST", "/positions"), ("GET", "/exchange/keys"), ("GET", "/exchange/keys/remove"), ("GET", "/exchange/keys/"),
             ("GET", "/Positions"), ("POST", "/exchange/k%65ys"), ("POST", "/exchange%2Fkeys")):
    http(f"route {m} {p}", 201, m, B + p, "{}" if m == "POST" else None, dt=31)

# exec (confirm mode)
PT_BY_OK = BY_BASE + [R("POST", "/v5/order/create", by_order("ord-entry"), by_order("ord-tp2"), by_order("ord-tp3")),
                      R("GET", "/v5/position/list", by_pos([by_p()]))]
PT_BY_FAIL = BY_BASE + [R("POST", "/v5/order/create", by_err(110007, "ab not enough for new order"))]
PT_BY_SPLIT = BY_BASE[:4] + [R("GET", "/v5/market/instruments-info", by_instr("0.1", "0.01")),
                             R("POST", "/v5/order/create", by_order("lo-1"), by_order("hi-1"), by_order("t1")),
                             R("GET", "/v5/position/list", by_pos([by_p("SOLUSDT", "2", 0, "150")]))]
PT_BX_OK = [R("GET", "/openApi/swap/v2/quote/contracts", BX_CONTRACTS), R("GET", "/openApi/swap/v2/user/balance", bx_bal()),
            R("POST", "/openApi/swap/v2/trade/leverage", {"code": 0, "msg": "", "data": {"leverage": 10, "symbol": "BTC-USDT"}}),
            R("GET", "/openApi/swap/v2/quote/price", {"code": 0, "msg": "", "data": {"symbol": "BTC-USDT", "price": "87010.0", "time": 1767225600000}}),
            R("POST", "/openApi/swap/v2/trade/order", bx_order(1735947220470939648), bx_order(11), bx_order(12), bx_order(13), bx_order(14)),
            R("GET", "/openApi/swap/v2/user/positions", bx_pos()),
            R("GET", "/openApi/swap/v2/trade/openOrders", bx_oo({"orderId": 12, "type": "TAKE_PROFIT_MARKET", "side": "SELL"},
                                                             {"orderId": 13, "type": "TAKE_PROFIT_MARKET", "side": "SELL"},
                                                             {"orderId": 14, "type": "TAKE_PROFIT_MARKET", "side": "SELL"}))]
PT_BX_FAIL = [R("GET", "/openApi/swap/v2/quote/contracts", BX_CONTRACTS), R("GET", "/openApi/swap/v2/user/balance", bx_err(100413, "Incorrect apiKey"))]
PT_BN_OK = [R("GET", "/fapi/v1/exchangeInfo", BN_INFO), R("GET", "/fapi/v2/balance", bn_bal()),
            R("POST", "/fapi/v1/positionSide/dual", {"code": -4059, "msg": "No need to change position side."}),
            R("POST", "/fapi/v1/leverage", {"leverage": 10, "symbol": "BTCUSDT"}),
            R("GET", "/fapi/v1/ticker/price", {"symbol": "BTCUSDT", "price": "87010.0", "time": 1767225600000}),
            R("POST", "/fapi/v1/order", bn_order(1, status="FILLED", avgPrice="87010.0", executedQty="0.010"), bn_order(2), bn_order(3), bn_order(4), bn_order(5)),
            R("GET", "/fapi/v2/positionRisk", bn_pos("0.010")),
            R("GET", "/fapi/v1/openOrders", [])]
PT_BN_FAIL = [R("GET", "/fapi/v1/exchangeInfo", BN_INFO), R("GET", "/fapi/v2/balance", bn_err(-2015, "Invalid API-key, IP, or permissions for action."))]
PT_OK_OK = [R("GET", "/api/v5/public/instruments", ok_inst()), R("GET", "/api/v5/account/balance", OK_BAL),
            R("POST", "/api/v5/account/set-leverage", OK_LEV), R("POST", "/api/v5/trade/order", OK_ORDER),
            R("POST", "/api/v5/trade/order-algo", ok_ok({"algoId": "a2", "sCode": "0", "sMsg": ""}), ok_ok({"algoId": "a3", "sCode": "0", "sMsg": ""}))]
PT_OK_FAIL = [R("GET", "/api/v5/public/instruments", ok_inst("ETH-USDT-SWAP", "0.1", "0.01", "100", "0.1")),
              R("GET", "/api/v5/account/balance", ok_err("50111", "Invalid OK-ACCESS-KEY"))]

cb("exec bybit opened", 204, "exec_trade", "exec_trade_ex-by-1", "ex-by-1", routes=PT_BY_OK)
cb("exec bybit again (button gone on the site; bot: already on exchange)", 204, "exec_trade", "exec_trade_ex-by-1", "ex-by-1", routes=PT_BY_OK,
   site="not_found")
cb("exec bybit rejected", 204, "exec_trade", "exec_trade_ex-by-fail", "ex-by-fail", routes=PT_BY_FAIL)
cb("exec bybit SMC split", 204, "exec_trade", "exec_trade_ex-by-split", "ex-by-split", routes=PT_BY_SPLIT)
cb("exec bingx opened", 205, "exec_trade", "exec_trade_ex-bx-1", "ex-bx-1", routes=PT_BX_OK)
cb("exec bingx rejected", 205, "exec_trade", "exec_trade_ex-bx-fail", "ex-bx-fail", routes=PT_BX_FAIL)
cb("exec binance opened", 206, "exec_trade", "exec_trade_ex-bn-1", "ex-bn-1", routes=PT_BN_OK)
cb("exec binance rejected", 206, "exec_trade", "exec_trade_ex-bn-fail", "ex-bn-fail", routes=PT_BN_FAIL)
cb("exec okx opened", 207, "exec_trade", "exec_trade_ex-ok-1", "ex-ok-1", routes=PT_OK_OK)
cb("exec okx rejected", 207, "exec_trade", "exec_trade_ex-ok-fail", "ex-ok-fail", routes=PT_OK_FAIL)
cb("exec okx without passphrase", 208, "exec_trade", "exec_trade_ex-ok-nopp", "ex-ok-nopp", routes=PT_OK_FAIL)
cb("exec trade_exchange kraken → bybit", 209, "exec_trade", "exec_trade_ex-kr-1", "ex-kr-1", routes=PT_BY_OK)
cb("exec bybit demo user → live host (quirk)", 210, "exec_trade", "exec_trade_ex-demo-1", "ex-demo-1", routes=PT_BY_FAIL)
cb("exec expired pro (free access passes)", 211, "exec_trade", "exec_trade_ex-expired", "ex-expired", routes=PT_BX_FAIL)
cb("exec banned → sub_expired", 212, "exec_trade", "exec_trade_ex-banned", "ex-banned")
cb("exec no keys", 225, "exec_trade", "exec_trade_ex-nokeys", "ex-nokeys")
cb("exec okx no keys (Okx label)", 213, "exec_trade", "exec_trade_ex-okx-nokeys", "ex-okx-nokeys")
cb("exec empty trade_exchange", 218, "exec_trade", "exec_trade_ex-empty-ex", "ex-empty-ex", routes=PT_BY_FAIL)
cb("exec result already set", 204, "exec_trade", "exec_trade_ex-res", "ex-res")
cb("exec order already on exchange", 204, "exec_trade", "exec_trade_ex-oid", "ex-oid")
cb("exec limit reached", 214, "exec_trade", "exec_trade_ex-lim-b", "ex-lim-b")
cb("exec duplicate symbol", 204, "exec_trade", "exec_trade_ex-dup-b", "ex-dup-b")
cb("exec tp2 TEXT → exception text", 204, "exec_trade", "exec_trade_ex-tp2-str", "ex-tp2-str")
cb("exec entry_lo 'abc' → ValueError text", 204, "exec_trade", "exec_trade_ex-entry-str", "ex-entry-str")
cb("exec locked (second press)", 204, "exec_trade", "exec_trade_ex-locked", "ex-locked", pre_lock=True)
cb("exec foreign trade (bot opens it!) → site 404", 204, "exec_trade", "exec_trade_ex-foreign", "ex-foreign", routes=PT_BY_OK, site="not_found")
cb("exec card without the button → site 404", 204, "exec_trade", "exec_trade_ex-nobtn", "ex-nobtn", routes=PT_BY_OK, site="not_found")
cb("exec missing trade (bot: stale) → site 404", 204, "exec_trade", "exec_trade_nope", "nope", site="not_found")
cb("exec hostile id a/b → site 404", 204, "exec_trade", "exec_trade_../x", "../x", site="not_found")
cb("exec stage SL → stale (EXEC-STALE-GUARD)", 204, "exec_trade", "exec_trade_ex-st-sl", "ex-st-sl", routes=PT_BY_OK)
cb("exec stage TP1 → stale", 204, "exec_trade", "exec_trade_ex-st-tp1", "ex-st-tp1", routes=PT_BY_OK)
cb("exec stage MISSED → stale", 204, "exec_trade", "exec_trade_ex-st-missed", "ex-st-missed", routes=PT_BY_OK)
cb("exec stage EXPIRED → stale", 204, "exec_trade", "exec_trade_ex-st-expired", "ex-st-expired", routes=PT_BY_OK)
cb("exec older than the tracker horizon → stale", 204, "exec_trade", "exec_trade_ex-st-old", "ex-st-old", routes=PT_BY_OK)
cb("exec stage ENTRY → placed", 204, "exec_trade", "exec_trade_ex-st-entry", "ex-st-entry", routes=PT_BY_FAIL)

# quick close
POS_BY_1 = R("GET", "/v5/position/list", by_pos([by_p(size="0.0125")]))
CLOSE_BY_OK = [R("GET", "/v5/market/instruments-info", by_instr()), R("POST", "/v5/order/create", by_order("cl-1"))]
cb("qc half bybit", 219, "cb_qc_half", "qc_half_qc-by-1", "qc-by-1", routes=[POS_BY_1] + CLOSE_BY_OK)
cb("qc half bybit short pos_idx 2 rejected", 219, "cb_qc_half", "qc_half_qc-by-short", "qc-by-short",
   routes=[R("GET", "/v5/position/list", by_pos([by_p("ETHUSDT", "1.5", 2, "3000", "Sell")])),
           R("GET", "/v5/market/instruments-info", by_instr("0.01", "0.01")), R("POST", "/v5/order/create", by_err(110017, "position is zero"))])
cb("qc half bybit no position", 219, "cb_qc_half", "qc_half_qc-by-1", "qc-by-1", routes=[R("GET", "/v5/position/list", by_pos([by_p(size="0")]))])
cb("qc half bingx", 220, "cb_qc_half", "qc_half_qc-bx-1", "qc-bx-1",
   routes=[R("GET", "/openApi/swap/v2/user/positions", bx_pos(amt="0.0116")), R("GET", "/openApi/swap/v2/quote/contracts", BX_CONTRACTS),
           R("POST", "/openApi/swap/v2/trade/order", bx_order(61))])
cb("qc half binance", 221, "cb_qc_half", "qc_half_qc-bn-1", "qc-bn-1",
   routes=[R("GET", "/fapi/v2/positionRisk", bn_pos("0.022")), R("GET", "/fapi/v1/exchangeInfo", BN_INFO),
           R("GET", "/fapi/v1/positionSide/dual", {"dualSidePosition": True}), R("POST", "/fapi/v1/order", bn_order(77))])
cb("qc half okx → partial market order (QC-SIDE-FIX)", 222, "cb_qc_half", "qc_half_qc-ok-1", "qc-ok-1",
   routes=[R("GET", "/api/v5/account/positions", ok_pos("BTC-USDT-SWAP", "3")), R("GET", "/api/v5/public/instruments", ok_inst()),
           R("POST", "/api/v5/trade/order", OK_ORDER)])
cb("qc half okx below one lot → nothing sent", 222, "cb_qc_half", "qc_half_qc-ok-1", "qc-ok-1",
   routes=[R("GET", "/api/v5/account/positions", ok_pos("BTC-USDT-SWAP", "0.01")), R("GET", "/api/v5/public/instruments", ok_inst())])
cb("qc half bybit hedge → the LONG's size, not the first position", 219, "cb_qc_half", "qc_half_qc-by-1", "qc-by-1",
   routes=[R("GET", "/v5/position/list", by_pos([by_p(size="0.5", idx=2, side="Sell"), by_p(size="0.0125", idx=1, side="Buy")]))] + CLOSE_BY_OK)
cb("qc half bingx hedge → the LONG's size", 220, "cb_qc_half", "qc_half_qc-bx-1", "qc-bx-1",
   routes=[R("GET", "/openApi/swap/v2/user/positions", {"code": 0, "msg": "", "data": bx_pos(amt="0.3", side="SHORT")["data"] + bx_pos(amt="0.0116")["data"]}),
           R("GET", "/openApi/swap/v2/quote/contracts", BX_CONTRACTS), R("POST", "/openApi/swap/v2/trade/order", bx_order(63))])
cb("qc half kraken → not supported", 219, "cb_qc_half", "qc_half_qc-kraken", "qc-kraken")
cb("qc half SMC row (NULL exchange → bybit, no bybit keys)", 222, "cb_qc_half", "qc_half_qc-smc-null-ex", "qc-smc-null-ex")
cb("qc half closed trade", 219, "cb_qc_half", "qc_half_qc-closed", "qc-closed")
cb("qc half pos_idx NULL → int(None)", 219, "cb_qc_half", "qc_half_qc-posidx-null", "qc-posidx-null")
cb("qc half direction empty → refused before any request", 219, "cb_qc_half", "qc_half_qc-dir-empty", "qc-dir-empty", routes=[POS_BY_1] + CLOSE_BY_OK)
cb("qc half positions timeout", 219, "cb_qc_half", "qc_half_qc-by-1", "qc-by-1", routes=[R("GET", "/v5/position/list", {"raise": "timeout"})])
cb("qc half foreign → site 404", 205, "cb_qc_half", "qc_half_qc-by-1", "qc-by-1", site="not_found")
cb("qc half missing → site 404", 219, "cb_qc_half", "qc_half_nope", "nope", site="not_found")
cb("qc half without the button → site 404", 219, "cb_qc_half", "qc_half_qc-nobtn", "qc-nobtn", routes=[POS_BY_1] + CLOSE_BY_OK, site="not_found")
cb("qc full bybit", 219, "cb_qc_full", "qc_full_qc-by-1", "qc-by-1", routes=[POS_BY_1] + CLOSE_BY_OK)
cb("qc full bingx", 220, "cb_qc_full", "qc_full_qc-bx-1", "qc-bx-1",
   routes=[R("GET", "/openApi/swap/v2/user/positions", bx_pos(amt="0.0116")), R("GET", "/openApi/swap/v2/quote/contracts", BX_CONTRACTS),
           R("POST", "/openApi/swap/v2/trade/order", bx_order(62))])
OK_CLOSE = [R("GET", "/api/v5/account/positions", ok_pos()), R("POST", "/api/v5/trade/close-position", ok_err("51023", "Position does not exist")),
            R("GET", "/api/v5/trade/orders-pending", ok_ok({"ordId": "9", "instId": "BTC-USDT-SWAP", "side": "sell", "ordType": "limit"})),
            R("POST", "/api/v5/trade/cancel-order", ok_ok({"ordId": "9", "sCode": "0", "sMsg": ""})),
            R("GET", "/api/v5/trade/orders-algo-pending", ok_ok({"algoId": "sl-1"})), R("POST", "/api/v5/trade/cancel-algos", ok_ok())]
cb("qc full okx LONG failed close → SL/TP kept", 222, "cb_qc_full", "qc_full_qc-ok-1", "qc-ok-1", routes=OK_CLOSE)
cb("qc full okx LONG failed close, position gone → leftovers cancelled", 222, "cb_qc_full", "qc_full_qc-ok-1", "qc-ok-1",
   routes=[R("GET", "/api/v5/account/positions", ok_pos(), ok_ok())] + OK_CLOSE[1:])
cb("qc full okx LONG closed → leftovers cancelled", 222, "cb_qc_full", "qc_full_qc-ok-1", "qc-ok-1",
   routes=[R("GET", "/api/v5/account/positions", ok_pos(), ok_ok()),
           R("POST", "/api/v5/trade/close-position", ok_ok({"instId": "BTC-USDT-SWAP", "posSide": "long"}))] + OK_CLOSE[2:])
cb("qc full okx LONG closed, hedge SHORT alive → only the long side's orders go", 222, "cb_qc_full", "qc_full_qc-ok-1", "qc-ok-1",
   routes=[R("GET", "/api/v5/account/positions", ok_ok(ok_pos()["data"][0], ok_pos(p="2", side="short")["data"][0]), ok_pos(p="2", side="short")),
           R("POST", "/api/v5/trade/close-position", ok_ok({"instId": "BTC-USDT-SWAP", "posSide": "long"})),
           R("GET", "/api/v5/trade/orders-pending",
             ok_ok({"ordId": "9", "instId": "BTC-USDT-SWAP", "side": "buy", "posSide": "long", "ordType": "limit"},
                   {"ordId": "10", "instId": "BTC-USDT-SWAP", "side": "sell", "posSide": "short", "ordType": "limit"})),
           R("POST", "/api/v5/trade/cancel-order", ok_ok({"ordId": "9", "sCode": "0", "sMsg": ""})),
           R("GET", "/api/v5/trade/orders-algo-pending", ok_ok({"algoId": "sl-long", "posSide": "long"}, {"algoId": "sl-short", "posSide": "short"})),
           R("POST", "/api/v5/trade/cancel-algos", ok_ok())])
cb("qc full okx SHORT", 222, "cb_qc_full", "qc_full_qc-ok-short", "qc-ok-short",
   routes=[R("GET", "/api/v5/account/positions", ok_pos("ETH-USDT-SWAP", "3", "short")),
           R("POST", "/api/v5/trade/close-position", ok_ok({"instId": "ETH-USDT-SWAP", "posSide": "short"})),
           R("GET", "/api/v5/trade/orders-pending", ok_ok()), R("GET", "/api/v5/trade/orders-algo-pending", ok_ok())])
cb("qc full hold-lock dialog", 215, "cb_qc_full", "qc_full_qc-hold", "qc-hold")
cb("qc full hold-lock, no cache price → closes (fail-open)", 215, "cb_qc_full", "qc_full_qc-hold-nocache", "qc-hold-nocache",
   routes=[R("GET", "/v5/position/list", by_pos([by_p("NOCACHEUSDT", "3")])), R("GET", "/v5/market/instruments-info", by_instr("1", "0.0001")),
           R("POST", "/v5/order/create", by_order("cl-9"))])
cb("qc full hold-lock min 0 → 0.5", 216, "cb_qc_full", "qc_full_qc-hold0", "qc-hold0")
cb("qc full closed", 219, "cb_qc_full", "qc_full_qc-closed", "qc-closed")
cb("qc full foreign → site 404", 205, "cb_qc_full", "qc_full_qc-by-1", "qc-by-1", site="not_found")
cb("qc force after hold-lock", 215, "cb_qc_full_force", "qc_full_force_qc-hold", "qc-hold",
   routes=[R("GET", "/v5/position/list", by_pos([by_p("ETHUSDT", "0.5", 0, "3000")])), R("GET", "/v5/market/instruments-info", by_instr("0.01", "0.01")),
           R("POST", "/v5/order/create", by_order("cl-h"))])
cb("qc force okx row of the hold user", 215, "cb_qc_full_force", "qc_full_force_qc-hold-okx", "qc-hold-okx", routes=OK_CLOSE)
cb("qc force closed", 219, "cb_qc_full_force", "qc_full_force_qc-closed", "qc-closed")
cb("qc force foreign → site 404", 205, "cb_qc_full_force", "qc_full_force_qc-hold", "qc-hold", site="not_found")
cb("qc force missing → site 404", 219, "cb_qc_full_force", "qc_full_force_nope", "nope", site="not_found")
cb("qc wait", 215, "cb_holdlock_wait", "qc_holdlock_wait", "qc-hold")
TRAIL_BY_OK = [R("GET", "/v5/market/instruments-info", by_instr()), R("GET", "/v5/market/tickers", BY_TICK), R("POST", "/v5/position/trading-stop", BY_OK)]
cb("qc be bybit", 219, "cb_qc_be", "qc_be_qc-by-1", "qc-by-1", routes=TRAIL_BY_OK)
cb("qc be bybit rejected", 219, "cb_qc_be", "qc_be_qc-by-short", "qc-by-short",
   routes=[R("GET", "/v5/market/instruments-info", by_instr("0.01", "0.01")),
           R("GET", "/v5/market/tickers", {"retCode": 0, "retMsg": "OK", "result": {"list": [{"symbol": "ETHUSDT", "markPrice": "2980", "lastPrice": "2980"}]}}),
           R("POST", "/v5/position/trading-stop", by_err(10001, "StopLoss invalid"))])
cb("qc be bingx", 220, "cb_qc_be", "qc_be_qc-bx-1", "qc-bx-1",
   routes=[R("GET", "/openApi/swap/v2/quote/contracts", BX_CONTRACTS), R("GET", "/openApi/swap/v2/user/positions", bx_pos()),
           R("POST", "/openApi/swap/v2/trade/order", bx_order(777)), R("GET", "/openApi/swap/v2/trade/openOrders", bx_oo())])
cb("qc be okx", 222, "cb_qc_be", "qc_be_qc-ok-1", "qc-ok-1",
   routes=[R("GET", "/api/v5/trade/orders-algo-pending", ok_ok()), R("GET", "/api/v5/account/positions", ok_pos()),
           R("GET", "/api/v5/public/instruments", ok_inst()),
           R("POST", "/api/v5/trade/order-algo", ok_ok({"algoId": "sl-2", "sCode": "0", "sMsg": ""}))])
cb("qc be entry 0", 219, "cb_qc_be", "qc_be_qc-entry0", "qc-entry0")
cb("qc be uses the row exchange (bybit), not trade_exchange (bingx)", 217, "cb_qc_be", "qc_be_qc-217-by", "qc-217-by", routes=TRAIL_BY_OK)
cb("qc be foreign → site 404", 205, "cb_qc_be", "qc_be_qc-by-1", "qc-by-1", site="not_found")
# progress
for tid in ("pr-long", "pr-short", "pr-nosl", "pr-nodata", "pr-closed", "pr-future", "pr-5m", "pr-entry0", "a/b", "тест-1"):
    cb(f"progress {tid}", 219, "cb_qc_refresh", f"qc_refresh_{tid}", tid)
cb("progress foreign → site 404", 205, "cb_qc_refresh", "qc_refresh_pr-long", "pr-long", site="not_found")
cb("progress missing → site 404", 219, "cb_qc_refresh", "qc_refresh_nope", "nope", site="not_found")


# the exact bytes the fakes serve (FakeAioResponse / the requests fake: json.dumps(spec["json"])) — the JS
# replay serves the same text
def _freeze(routes):
    for r in routes:
        for resp in r["responses"]:
            if "json" in resp:
                resp["text"] = json.dumps(resp.pop("json"))


for _s in STEPS:
    _freeze(_s["routes"])


# ── recording CallbackQuery ──────────────────────────────────────────────────
def kbd(markup):
    if markup is None:
        return None
    return [[{"text": b.text, "callback_data": b.callback_data} for b in row] for row in markup.inline_keyboard]


class _Sent:
    def __init__(self, rec, idx):
        self.rec, self.idx = rec, idx

    async def delete(self):
        self.rec.append({"op": "delete", "of": self.idx})


class _Msg:
    def __init__(self, rec):
        self.rec = rec

    async def edit_text(self, text, parse_mode=None, reply_markup=None, **kw):
        self.rec.append({"op": "edit", "text": text, "parse_mode": parse_mode, "keyboard": kbd(reply_markup)})

    async def edit_reply_markup(self, reply_markup=None, **kw):
        self.rec.append({"op": "edit_markup", "keyboard": kbd(reply_markup)})

    async def answer(self, text, parse_mode=None, reply_markup=None, **kw):
        idx = len(self.rec)
        self.rec.append({"op": "send", "text": text, "parse_mode": parse_mode, "keyboard": kbd(reply_markup)})
        return _Sent(self.rec, idx)


class _User:
    def __init__(self, uid):
        self.id = uid


class _CB:
    def __init__(self, data, uid):
        self.data = data
        self.from_user = _User(uid)
        self.effects = []
        self.message = _Msg(self.effects)

    async def answer(self, text=None, show_alert=None, **kw):
        self.effects.append({"op": "answer", "text": text, "show_alert": bool(show_alert)})


class _DP:
    def __init__(self):
        self.handlers = {}

    def callback_query(self, *a, **k):
        def deco(fn):
            self.handlers[fn.__name__] = fn
            return fn
        return deco

    def message(self, *a, **k):
        return lambda fn: fn


class _LogCap(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines = []

    def emit(self, record):
        if record.levelno >= logging.INFO:
            self.lines.append(f"{record.levelname} {record.getMessage()}")


LOGS = _LogCap()
for name in ("CHM.MiniApp", "CHM.Handlers.trading", "CHM.QuickClose", "CHM.Handlers.QuickClose"):
    lg = logging.getLogger(name)
    lg.addHandler(LOGS)
    lg.setLevel(logging.DEBUG)
    lg.propagate = False
logging.getLogger().setLevel(logging.WARNING)


def _tg_user(request):
    v = request.headers.get("X-Test-Uid", "")
    return {"id": int(v), "username": f"user{v}", "first_name": "T", "language_code": "ru"} if v else None


api._tg_user = _tg_user
REAL_WAIT_FOR = asyncio.wait_for
_REAL_MONO = _time.monotonic


# ── exchange fakes per step (harness.run_scenario's setup without the call) ──
class _ExCtx:
    def __init__(self, routes, start):
        self.clock = harness.Clock(start)
        self.router = harness.Router(routes)
        self.cap = harness.LogCapture()

    def __enter__(self):
        clock, router = self.clock, self.router
        harness.reset_state(clock)
        tp = harness._time_proxy(clock)
        ap = harness._asyncio_proxy(clock)
        for mod in (by, bx, bn, ok):
            mod.time = tp
            mod.asyncio = ap
        harness.api_retry.asyncio = ap
        harness.api_retry.random = harness._Random(clock)
        harness.exchange_breaker.time = tp
        harness.pyhttp.time = tp
        harness.pyhelpers.time = tp
        harness.pyhttp.dt = harness._dt_proxy(clock)
        ok.datetime = harness._dt_proxy(clock)
        by._api_bucket = by._TokenBucket(rate=10.0, burst=15)
        by._async_api_bucket = by._AsyncTokenBucket(rate=10.0, burst=15)
        fake = harness.FakeAioSession(router)

        async def _gs():
            return fake
        for mod in (by, bx, bn, ok):
            mod._get_http_session = _gs
        aio_ns = types.SimpleNamespace(**{k: getattr(harness.aiohttp, k) for k in dir(harness.aiohttp) if not k.startswith("__")})
        aio_ns.ClientSession = lambda *a, **k: fake
        bn.aiohttp = aio_ns

        async def _reset():
            return None
        by._reset_http_session = _reset
        harness.install_requests_fake(router)
        by._get_session = harness._ORIG_GET_SESSION

        class _DB:
            async def db_get_hedge_mode(self, api_key):
                return None

            async def db_save_hedge_mode(self, api_key, is_hedge):
                return None

            async def db_find_user_ids_by_api_key(self, exchange, api_key):
                return []

            async def db_set_auto_trade(self, uid, enabled):
                return None
        by.db = _DB()

        async def _ks(context=""):
            return None
        harness.ks.require_active = _ks

        async def _deny(user_id, symbol, source):
            return None
        harness.plan_gate.deny_reason = _deny

        async def _rec(name, value=1.0, tags=None):
            return None
        harness.metrics_mod.record = _rec
        harness.trade_events.emit_bg = lambda tid, evt, payload=None: None
        self.loggers = [logging.getLogger(n) for n in ("CHM.Bybit", "CHM.BingX", "CHM.Binance", "CHM.OKX.Trader", "CHM.ApiRetry", "CHM.ExchangeBreaker")]
        for lg in self.loggers:
            lg.addHandler(self.cap)
            lg.setLevel(logging.DEBUG)
            lg.propagate = False
        self.saved_time = sys.modules["time"]
        sys.modules["time"] = tp
        return self

    def __exit__(self, *a):
        sys.modules["time"] = self.saved_time
        for lg in self.loggers:
            lg.removeHandler(self.cap)
        return False

    def result(self):
        return {"requests": self.router.log, "sleeps": self.clock.sleeps,
                "markers": [[lvl, m] for lvl, msg in self.cap.records for m in harness.MARKER_RE.findall(msg)]}


# ── raw HTTP (as tests/app/data/py/drive_app_data.py) ────────────────────────
async def raw_request(port, method, target, uid, body, ctype):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    data = body.encode("utf-8") if isinstance(body, str) else (body or b"")
    head = [f"{method} {target} HTTP/1.1", "Host: 127.0.0.1", "Connection: close"]
    if uid is not None:
        head.append(f"X-Test-Uid: {uid}")
    if ctype and body is not None:
        head.append(f"Content-Type: {ctype}")
    if method in ("POST", "PUT", "DELETE") or data:
        head.append(f"Content-Length: {len(data)}")
    writer.write(("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + data)
    await writer.drain()
    raw = await reader.read()
    writer.close()
    hdr, _, rest = raw.partition(b"\r\n\r\n")
    lines = hdr.decode("latin-1").split("\r\n")
    status = int(lines[0].split(" ")[1])
    headers = {}
    for ln in lines[1:]:
        k, _, v = ln.partition(":")
        headers[k.strip().lower()] = v.strip()
    if headers.get("transfer-encoding") == "chunked":
        out = b""
        while rest:
            size, _, rest = rest.partition(b"\r\n")
            n = int(size, 16)
            if n == 0:
                break
            out += rest[:n]
            rest = rest[n + 2:]
        rest = out
    return status, headers, rest.decode("utf-8", "replace")


USER_FIELDS = ["bybit_api_key", "bybit_api_secret", "bingx_api_key", "bingx_api_secret", "binance_api_key", "binance_api_secret",
               "okx_api_key", "okx_api_secret", "okx_passphrase", "bybit_demo", "trade_exchange", "auto_trade"]
TRADE_SNAP = ["order_id", "pos_idx", "qty", "tp_placed", "be_set", "result", "state"]


async def user_snapshot(um, uid):
    u = await um.get(uid)
    return None if u is None else {f: getattr(u, f) for f in USER_FIELDS}


def trade_snapshot(tid):
    con = sqlite3.connect(DBP)
    row = con.execute(f"SELECT {', '.join(TRADE_SNAP)} FROM trades WHERE trade_id=?", (tid,)).fetchone()
    con.close()
    return None if row is None else dict(zip(TRADE_SNAP, row))


async def d15_wire():
    """The permission read of each exchange as the bot's own signing code builds it (recorded, not answered)."""
    out = {}
    for ex in ("bybit", "bingx", "binance", "okx"):
        key, sec, pp = K[ex]
        with _ExCtx([d15_route(ex, "ok")], NOW) as ctx:
            if ex == "bybit":
                for demo in (False, True):
                    s = by._get_session(key, sec, demo=demo)
                    s.get_api_key_information()
            elif ex == "bingx":
                await bx._request("GET", "/openApi/v1/account/apiPermissions", key, sec)
            elif ex == "binance":
                qs, headers = bn._build_query(key, sec, {})
                url = f"https://api.binance.com/sapi/v1/account/apiRestrictions?{qs}"
                fake = await bn._get_http_session()
                async with fake.get(harness.yarl.URL(url, encoded=True), headers=headers) as r:
                    await r.json()
            else:
                await ok._request("GET", "/api/v5/account/config", key, sec, pp)
        out[ex] = ctx.result()["requests"]
    return out


# ── run ──────────────────────────────────────────────────────────────────────
def stage(msg):
    if os.environ.get("DRIVE_VERBOSE"):
        print(f"[stage] {msg}", file=sys.stderr, flush=True)


async def main():
    if os.environ.get("DRIVE_VERBOSE"):
        import faulthandler
        faulthandler.dump_traceback_later(25, exit=True)
    stage("init_db")
    await database.init_db(DBP)
    stage("users")
    um = UserManager()
    for uid, plan, status, exp, lang, extra, keys in USERS:
        u = await um.get_or_create(uid, f"user{uid}", "ru")
        u.sub_plan, u.sub_status, u.sub_expires, u.lang = plan, status, NOW + exp if exp else 0, lang
        for k, v in extra.items():
            setattr(u, k, v)
        for ex, (key, sec, pp) in keys.items():
            setattr(u, f"{ex}_api_key", key)
            setattr(u, f"{ex}_api_secret", sec)
            if ex == "okx":
                u.okx_passphrase = pp
        await um.save(u)
    stage("trades")
    con = sqlite3.connect(DBP)
    for r in TRADES:
        cols = [c for c in TRADE_COLS if c in r]
        con.execute(f"INSERT INTO trades ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", [r[c] for c in cols])
    con.commit()
    con.close()
    stage("cache")
    cache.init_cache(4000)
    for (sym, tf), close in CANDLES.items():
        await cache.set_candles(sym, tf, to_df(bars_for(close)), {tf: 10 * 86400})
    stage("server")
    app = web.Application()
    api.register(app, bot=None, um=um, scanner=None)
    server = TestServer(app)
    await server.start_server()
    port = server.port
    stage("handlers")
    dp = _DP()
    h_trading.register_handlers(dp, None, um, None, None)
    h_qc.register_handlers(dp, None, um, None, None)
    out = []
    for i, s in enumerate(STEPS):
        CLOCK[0] = s["now"]
        LOGS.lines.clear()
        t_step = _REAL_MONO()
        if os.environ.get("DRIVE_VERBOSE"):
            print(f"step {i} {s['name']}", file=sys.stderr, flush=True)
        rec = dict(s)
        timeout = s.get("force_timeout") if s["kind"] == "http" else None

        async def _wait_for(aw, t, _real=REAL_WAIT_FOR, _force=timeout):
            return await _real(aw, 0 if _force else t)
        api.asyncio = types.SimpleNamespace(**{k: getattr(asyncio, k) for k in dir(asyncio) if not k.startswith("__")})
        api.asyncio.wait_for = _wait_for
        with _ExCtx(s["routes"], s["now"]) as ctx:
            if s["kind"] == "http":
                status, headers, text = await raw_request(port, s["method"], s["path"], s["uid"], s["body"], s["ctype"])
                rec.update({"status": status, "headers": {k: headers[k] for k in ("retry-after", "allow", "content-type") if k in headers},
                            "text": text})
            else:
                lock = None
                if s["pre_lock"]:
                    lock = h_common._exec_trade_locks.setdefault(s["tid"], asyncio.Lock())
                    await lock.acquire()
                fake_cb = _CB(s["data"], s["uid"])
                try:
                    await dp.handlers[s["handler"]](fake_cb)
                    rec["raised"] = None
                except Exception as e:  # noqa: BLE001
                    rec["raised"] = f"{type(e).__name__}: {e}"
                if lock is not None:
                    lock.release()
                rec["effects"] = fake_cb.effects
                # what get_current_pnl gave the progress card / the hold-lock check (same clock, same cache)
                if s["handler"] in ("cb_qc_refresh", "cb_qc_full"):
                    tr = await database.db_get_trade(s["tid"])
                    u = await um.get(s["uid"])
                    rec["pnl"] = await quick_close.get_current_pnl(u, tr) if tr and u else None
        for _ in range(3):
            await asyncio.sleep(0)
        rec.update(ctx.result())
        rec["logs"] = list(LOGS.lines)
        if s["uid"] is not None:
            rec["user_after"] = await user_snapshot(um, s["uid"])
        if s.get("tid"):
            rec["trade_after"] = trade_snapshot(s["tid"])
        out.append(rec)
        if _REAL_MONO() - t_step > 2:
            print(f"SLOW step {i} {s['name']}: {_REAL_MONO() - t_step:.1f}s", file=sys.stderr, flush=True)
    await server.close()
    texts = {k: I18N[k] for k in ("exec_api_not_setup", "exec_opening", "exec_placing_order", "exec_signal_stale", "exec_already_opened",
                                   "exec_already_on_exchange", "exec_trade_locked", "exec_limit_reached", "exec_dup_symbol", "sub_expired",
                                   "signal_open_trade_btn")}
    fixture = {
        "python": sys.version.split()[0], "now": NOW, "keys": K, "users": USERS, "trades": TRADES, "trade_cols": TRADE_COLS,
        "candles": [[sym, tf, bars_for(close)] for (sym, tf), close in CANDLES.items()],
        "d15": D15, "d15_path": D15_PATH, "d15_wire": await d15_wire(), "i18n": texts,
        "miniapp": {"keys_rate": list(api.KEYS_RATE_LIMIT), "positions_rate": list(api.POSITIONS_RATE_LIMIT), "exchanges": list(api._EXCHANGES)},
        "steps": out,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with gzip.open(OUT, "wt", encoding="utf-8") as fh:
        json.dump(harness._jsonable(fixture), fh, ensure_ascii=True, allow_nan=True)
    print(len(out), "steps →", OUT)


try:
    asyncio.run(main())
except BaseException:  # noqa: BLE001 — some bot module replaces sys.excepthook; print it here
    import traceback
    traceback.print_exc()
    sys.stderr.flush()
    os._exit(1)
sys.stdout.flush()
os._exit(0)
