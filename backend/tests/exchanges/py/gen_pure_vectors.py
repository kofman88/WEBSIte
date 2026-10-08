"""Expected values for the pure exchange helpers, computed by the bot's own Python code.

Run (writes ../fixtures/pure_vectors.json):

  cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \
    $VENV/bin/python /path/to/backend/tests/exchanges/py/gen_pure_vectors.py; \
    rm -f signal_registry.json

Covers: price_precision (step_decimals / round_qty / round_price / round_price_sl /
round_price_tp / fmt_price_display), order_id_utils.compute_client_order_id,
tp_ladder_fit.fit_partial_split, api_retry (is_retryable_error / _result_is_retryable),
exchange_breaker.is_transient_error, auto_trade._is_user_facing_error / _is_auth_failure,
repr(json.loads(text)), urllib quote/urlencode, float() parsing, BingX tick 10**-p,
signatures of all four traders on fixed (key, secret, params, timestamp), the error
humanizers and the symbol maps / price multipliers.
"""
import json
import os
import random
import sys
from urllib.parse import quote, quote_plus, urlencode

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
sys.path.insert(0, BOT)
os.chdir(BOT)

import price_precision as pp  # noqa: E402
import order_id_utils as oid  # noqa: E402
import tp_ladder_fit as tlf  # noqa: E402
import api_retry  # noqa: E402
import exchange_breaker  # noqa: E402
import auto_trade  # noqa: E402
import bybit_trader as by  # noqa: E402
import bingx_trader as bx  # noqa: E402
import binance_trader as bn  # noqa: E402
import okx_trader as ok  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "pure_vectors.json")
rng = random.Random(20261008)


def safe(fn, *a, **k):
    try:
        return {"ok": fn(*a, **k)}
    except Exception as e:  # noqa: BLE001
        return {"exc": type(e).__name__, "msg": str(e)}


# ── price precision ──────────────────────────────────────────────────────────
STEPS = [0.001, 0.01, 0.1, 0.5, 1, 1.0, 10, 100, 0.0001, 0.00001, 1e-6, 1e-7, 1e-8, 1e-9, 1e-10,
         1e-11, 0.25, 0.005, 0.0005, 2.64, 0.3, 0, -1, 5e-05, 0.000001, 1000, 0.02, 0.2, 0.05]
step_dec = [[s, pp.step_decimals(s)] for s in STEPS]

qty_cases = []
for q, s in [(0.0046, 0.001), (123.7, 1), (0, 0.001), (-1, 0.001), (5.0, 0), (0.3, 0.1), (0.7, 0.1),
             (1.0000000001, 0.001), (21.6, 1.0), (787.5, 1), (0.29999999999999999, 0.1),
             (1e-9, 1e-8), (12345678.9, 0.001), (0.15, 0.05), (2.28, 2.64), (1.86, 2.64),
             (100.0, 0.1), (3.3, 1.1), (0.0003, 0.0001), (99999.99999, 0.01)]:
    qty_cases.append([q, s, safe(pp.round_qty, q, s)])
for _ in range(400):
    s = rng.choice([0.001, 0.01, 0.1, 1, 10, 0.0001, 1e-5, 5, 0.5, 0.25, 0.05, 2.64, 1e-8, 100])
    q = rng.choice([rng.uniform(0, 10), rng.uniform(0, 1e6), rng.uniform(0, 0.01), rng.random() * 100])
    q = float(f"{q:.{rng.randint(0, 12)}g}")
    qty_cases.append([q, s, safe(pp.round_qty, q, s)])

price_cases = []
TICKS = [1, 0.1, 0.01, 0.001, 0.0001, 0.00001, 1e-6, 1e-7, 1e-8, 1e-9, 1e-10, 0.5, 0.25, 0.05, 0.005, 0, -0.1, 10]
for p_, t in [(87490.5, 1), (0.090015, 0.0001), (87490.7, 1), (87490.3, 1), (0.125, 0.01), (0.375, 0.01),
              (2.675, 0.01), (1.005, 0.01), (0.00000391, 1e-8), (3.91, 0.0001), (0.003905, 0.000001),
              (0, 0.01), (-5, 0.01), (1e30, 1), (1e25, 0.001), (1e27, 0.1), (123456789012345.6, 0.1),
              (5e-324, 1e-8), (1e-12, 1e-8), (0.1 + 0.2, 0.1), (100.0, 0.0), (0.035, 0.01), (0.045, 0.01),
              (1.15, 0.05), (1.25, 0.5), (999999.99995, 0.0001), (float("nan"), 0.01)]:
    price_cases.append([p_, t,
                        safe(pp.round_price, p_, t),
                        safe(pp.round_price_sl, p_, t, "LONG"), safe(pp.round_price_sl, p_, t, "SHORT"),
                        safe(pp.round_price_tp, p_, t, "LONG"), safe(pp.round_price_tp, p_, t, "short")])
for _ in range(600):
    t = rng.choice(TICKS[:15])
    mag = rng.choice([1e-8, 1e-6, 1e-4, 0.01, 1, 100, 1e4, 1e5])
    p_ = rng.uniform(0, 10) * mag
    p_ = float(f"{p_:.{rng.randint(1, 17)}g}")
    price_cases.append([p_, t,
                        safe(pp.round_price, p_, t),
                        safe(pp.round_price_sl, p_, t, "LONG"), safe(pp.round_price_sl, p_, t, "SHORT"),
                        safe(pp.round_price_tp, p_, t, "LONG"), safe(pp.round_price_tp, p_, t, "SHORT")])
# exact half ticks
for _ in range(150):
    t = rng.choice([1, 0.1, 0.01, 0.001, 0.0001, 0.5, 0.05])
    n = rng.randint(1, 10**6)
    p_ = float(f"{(n + 0.5) * t:.12g}")
    price_cases.append([p_, t,
                        safe(pp.round_price, p_, t),
                        safe(pp.round_price_sl, p_, t, "LONG"), safe(pp.round_price_sl, p_, t, "SHORT"),
                        safe(pp.round_price_tp, p_, t, "LONG"), safe(pp.round_price_tp, p_, t, "SHORT")])

disp_cases = []
for v in [1.0145830379999998, 0.98748, 0.994129, 4.13206e-06, 0, None, 87490.5, 0.0123456789, 1e-12,
          -3.5, 123456.123456789, 0.00012345678, 0.000099999999, 2.5e-05, 1e20]:
    disp_cases.append([v, pp.fmt_price_display(v)])
for _ in range(200):
    v = rng.uniform(0, 10) * rng.choice([1e-8, 1e-5, 1e-3, 0.1, 1, 1000])
    disp_cases.append([v, pp.fmt_price_display(v)])

# ── order ids ───────────────────────────────────────────────────────────────
cids = []
for tid in ["", "abc", "t-123", "12345", "привет"]:
    for uid in [0, 1, 123456789, -5]:
        for ex in ["bybit", "bingx", "binance", "okx"]:
            for ot in oid.ORDER_TYPES:
                for att in [1, 2]:
                    cids.append([tid, uid, ex, ot, att, oid.compute_client_order_id(tid, uid, ex, ot, att)])

# ── tp ladder fit ───────────────────────────────────────────────────────────
fits = []
for args in [
    dict(total_qty=10, price=1.0, qty_step=0.1),
    dict(total_qty=10, price=2.0, qty_step=0.1),
    dict(total_qty=10, price=1.2, qty_step=0.1),
    dict(total_qty=10, price=0.8, qty_step=0.1),
    dict(total_qty=10, price=0.4, qty_step=0.1),
    dict(total_qty=0, price=1.0, qty_step=0.1),
    dict(total_qty=10, price=0, qty_step=0.1),
    dict(total_qty=1000, price=0.00000391, qty_step=1, pmult=1000.0, exchange="bybit"),
    dict(total_qty=5000, price=0.00000391, qty_step=1, pmult=1000.0),
    dict(total_qty=3, price=5.0, qty_step=1, desired_tp1_pct=50, desired_tp2_pct=40),
    dict(total_qty=3, price=5.0, qty_step=1, desired_tp1_pct=50, desired_tp2_pct=50),
    dict(total_qty=3, price=5.0, qty_step=1, desired_tp1_pct=60, desired_tp2_pct=60),
    dict(total_qty=2, price=100, qty_step=0.5, min_notional_override=20),
    dict(total_qty=0.01, price=60000, qty_step=0.001, exchange="binance"),
    dict(total_qty=0.003, price=60000, qty_step=0.001, exchange="OKX"),
    dict(total_qty=0.0001, price=60000, qty_step=0.001),
]:
    fits.append([args, tlf.fit_partial_split(**args)])
for _ in range(300):
    args = dict(
        total_qty=float(f"{rng.uniform(0, 100):.6g}"),
        price=float(f"{rng.uniform(0.01, 50):.6g}"),
        qty_step=rng.choice([0.001, 0.01, 0.1, 1.0, 0.5]),
        pmult=rng.choice([1.0, 1.0, 1000.0]),
        exchange=rng.choice(["bybit", "bingx", "binance", "okx", "kraken", ""]),
        min_notional_override=rng.choice([0.0, 0.0, 10.0]),
        desired_tp1_pct=rng.choice([40.0, 50.0, 25.0, 60.0, 100.0, 0.0]),
        desired_tp2_pct=rng.choice([30.0, 40.0, 25.0, 0.0, 50.0]),
    )
    fits.append([args, tlf.fit_partial_split(**args)])
min_notional = [[e, tlf.get_min_notional(e)] for e in ["bybit", "BINGX", "binance", "okx", "", None, "kraken"]]

# ── api_retry / breaker / classifiers ─────────────────────────────────────────
ERRS = ["", None, "timeout", "Read timed out", "429 Too Many Requests", "ErrCode: 10003 api key invalid",
        "(ErrCode: 10002) timestamp", "insufficient balance 429", "Connection reset by peer",
        "502 Bad Gateway", "Symbol invalid", "Contract is not live", "10006 Request frequent",
        "Retryable error occurred, retrying...", "position not found", "403 Forbidden", "socket hang up",
        "network unreachable", "internal error; try again", "110007 not enough", "mark price lag",
        "Service Unavailable", "unknown", "API key is invalid (10003)", "api key повреждён",
        "Auth failed after trying UNIFIED/CONTRACT", "code: -2014", "code:-1021 x", "{'code': -2015}",
        "Qty invalid (ErrCode: 10001)", "110043", "errcode: 34040 not modified", "100413",
        "Недостаточно средств: $0.50 USDT", "Недостаточно маржи для открытия позиции",
        "limit order not filled yet", "position closed before TP", "server_timestamp mismatch",
        "max retries exceeded", "connection aborted", "500 Internal Server Error", "5xx", "gateway timeout"]
retryable = [[e, api_retry.is_retryable_error(e)] for e in ERRS]
transient = [[e, exchange_breaker.is_transient_error(e if e is not None else "None")] for e in ERRS]
user_facing = [[e, auto_trade._is_user_facing_error(Exception(e if e is not None else "None"))] for e in ERRS]
auth_fail = [[e, auto_trade._is_auth_failure(Exception(e if e is not None else "None"))] for e in ERRS]
RESULTS = [
    {"ok": False, "error": "timeout"}, {"ok": False, "error": "10003"}, {"ok": False, "error": None},
    {"ok": True}, {"retCode": 10006, "retMsg": "Request frequent"}, {"retCode": 0}, {"retCode": None},
    {"retCode": 110007, "retMsg": "ab not enough"}, {"retCode": 10002, "error": "x"},
    {"code": -1021, "msg": "Timestamp outside recvWindow"}, {"code": -2014, "msg": "bad key"},
    {"code": 200, "msg": "ok"}, {"code": -1000, "msg": "unknown"}, {"code": -1003, "msg": "429 too many"},
    {"code": "-1", "msg": "timeout"}, {}, {"ok": False}, {"retCode": False}, {"retCode": "10006", "retMsg": "rate limit"},
]
result_retry = [[r, list(api_retry._result_is_retryable(r))] for r in RESULTS]

# ── repr / quoting / float() ────────────────────────────────────────────────
JSON_TEXTS = [
    '{"code": 0, "msg": "", "data": {"order": {"orderId": 123456789012345678}}}',
    '{"code":109400,"msg":"positionSide param is invalid","data":{}}',
    '{"retCode":0,"retMsg":"OK","result":{"list":[{"price":"1.0","size":1.0,"x":1e5,"y":-0.0,"z":-0}]}}',
    '[{"orderId": 1}, {"code": -2021, "msg": "Order would immediately trigger."}]',
    '{"msg": "can\'t place", "a": "say \\"hi\\"", "b": "both \' and \\"", "c": "tab\\tnl\\nback\\\\"}',
    '{"msg": "Недостаточно средств ✓", "z": "\\u200b zero width", "e": "\\u0007bell", "u": "\\ud83d\\ude80"}',
    '{"a": 1, "b": 2, "a": 3}',
    '{"2": "two", "1": "one", "10": "ten"}',
    '{"big": 12345678901234567890, "f": 0.1, "g": 1.5e-7, "h": 12345678901234567890.0}',
    'true', 'null', '"str"', '[]', '{}', '3.0', '42',
]
reprs = [[t, repr(json.loads(t))] for t in JSON_TEXTS]
STRS = ["", "abc", "a'b", 'a"b', "a'b\"c", "\x00\x1f\x7f", "é", "​", " ", " ", "😀", "\\", "tab\there", "Cyrillic Привет"]
str_reprs = [[s, repr(s)] for s in STRS]
QUOTE = ["abc", "a b", "a+b", "[{\"symbol\": \"BTC-USDT\"}]", "~-._", "!*'()", "é/ü", "1.5e-05", "a=b&c"]
quotes = [[s, quote(s, safe=""), quote_plus(s, safe="")] for s in QUOTE]
URLENC = [{"symbol": "BTCUSDT", "side": "BUY", "quantity": "0.001"}, {"a b": "c d", "x": "y+z", "batchOrders": '[{"a": 1}]'},
          {"n": 5, "f": 1.5, "t": True, "none": None}]
urlencs = [[d, urlencode(d)] for d in URLENC]
FLOATS = ["1.5", " 2 ", "1e5", "1_000.5", "inf", "-Infinity", "nan", "", "abc", "1.", ".5", "+3", "0x10", "1e", "1__0"]
floats = []
for s in FLOATS:
    try:
        v = float(s)
        floats.append([s, {"ok": repr(v)}])
    except Exception as e:  # noqa: BLE001
        floats.append([s, {"exc": type(e).__name__, "msg": str(e)}])
pow_ticks = [[p, repr(10 ** (-int(float(p))))] for p in range(0, 16)]

# ── signatures ──────────────────────────────────────────────────────────────
import hmac, hashlib  # noqa: E402,E401
from pybit._http_manager import _V5HTTPManager  # noqa: E402

KEY, SECRET = "XyZ123apiKEY", "s3cr3t-SECRET-value"
by_sig = []
mgr = _V5HTTPManager(api_key=KEY, api_secret=SECRET, recv_window=15000)
for method, params in [
    ("GET", {"category": "linear", "settleCoin": "USDT", "limit": 50}),
    ("GET", {"accountType": "UNIFIED", "coin": "USDT"}),
    ("POST", {"category": "linear", "symbol": "BTCUSDT", "side": "Buy", "orderType": "Limit", "qty": "0.012",
              "price": "87490.5", "timeInForce": "GTC", "positionIdx": 0, "orderLinkId": "chm_abcdef012345"}),
    ("POST", {"category": "linear", "symbol": "1000PEPEUSDT", "side": "Sell", "orderType": "Market", "qty": 12000,
              "reduceOnly": True, "positionIdx": 2.0, "stopLoss": 0.0123}),
    ("POST", {"category": "linear", "symbol": "ETHUSDT", "tradeMode": 1}),
    ("POST", {"category": "linear", "symbol": "SOLUSDT", "buyLeverage": "10", "sellLeverage": "10", "note": "Ünïcode"}),
]:
    q = mgr._clean_query(dict(params))
    payload = mgr.prepare_payload(method, q)
    for ts in [1767225600000, 1767225600123]:
        by_sig.append({"method": method, "params": params, "payload": payload, "ts": ts,
                       "sign": mgr._auth(payload=payload, recv_window=15000, timestamp=ts)})

bx_sig = []
for params in [{"symbol": "BTC-USDT", "side": "BUY", "quantity": "0.001", "timestamp": "1767225600000", "recvWindow": "15000"},
               {"batchOrders": json.dumps([{"symbol": "1000PEPE-USDT", "side": "BUY", "type": "MARKET", "quantity": "1000"}]),
                "timestamp": "1767225600000", "recvWindow": "15000"},
               {"symbol": "X-USDT", "note": "a b+c/é", "timestamp": "1", "recvWindow": "15000"}]:
    sig = bx._sign(params, SECRET)
    bx_sig.append({"params": params, "sign": sig})
# _build_query with patched clock
import time as _time  # noqa: E402
_orig_time = _time.time
_time.time = lambda: 1767225600.123
bx._bingx_time_offset_ms = 250
bq = bx._build_query(KEY, SECRET, {"symbol": "BTC-USDT", "side": "BUY", "positionSide": "LONG", "type": "MARKET", "quantity": "0.5"})
bx._bingx_time_offset_ms = 0
bn._binance_time_offset_ms = -120
nq = bn._build_query(KEY, SECRET, {"symbol": "BTCUSDT", "side": "BUY", "type": "LIMIT", "quantity": "0.002", "price": "87490.5", "timeInForce": "GTC"})
nq2 = bn._build_query(KEY, SECRET, {"batchOrders": json.dumps([{"symbol": "BTCUSDT", "side": "BUY", "type": "MARKET", "quantity": "0.002"}])})
bn._binance_time_offset_ms = 0
ok._okx_time_offset_ms = 0
from datetime import datetime, timezone  # noqa: E402


class _FixedDT(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 1, 1, 0, 0, 0, 987654, tzinfo=timezone.utc)


ok.datetime = _FixedDT
okx_ts = ok._iso_timestamp()
ok._okx_time_offset_ms = 1500
okx_ts_off = ok._iso_timestamp()
ok._okx_time_offset_ms = 0
okx_sig = []
for method, path, body in [("GET", "/api/v5/account/balance?ccy=USDT", ""),
                           ("POST", "/api/v5/trade/order", json.dumps({"instId": "BTC-USDT-SWAP", "tdMode": "cross", "side": "buy", "posSide": "long", "ordType": "market", "sz": "1"})),
                           ("POST", "/api/v5/trade/cancel-algos", json.dumps([{"algoId": "123", "instId": "BTC-USDT-SWAP"}]))]:
    okx_sig.append({"ts": okx_ts, "method": method, "path": path, "body": body, "sign": ok._sign(okx_ts, method, path, body, SECRET)})
_time.time = _orig_time

# ── humanizers / symbols ────────────────────────────────────────────────────
HUM_BY = ["", "Insufficient balance (ErrCode: 110007) (ErrTime: 10:00:00).\nRequest → POST x: {}.", "retCode: 10003 bad",
          "status_code 401", "boom (12345)", "(ErrCode: 999999) something weird", "contract is not live", "Auth failed after trying UNIFIED/CONTRACT. Last error: x",
          "Retryable error occurred, retrying...", "retryable auth", "abc", "x (ErrCode: 33) (ErrTime: 11:22:33)", "lowercase message here.",
          "(ErrCode: 130125) pos idx"]
hum_by = [[s, by._humanize_bybit_error(s)] for s in HUM_BY]
HUM_BX = ["", "{'code': 101204, 'msg': 'x'}", '{"code": 80014, "msg": "lev"}', "{'code': -1, 'msg': 'http=400; body={\"code\":109400,\"msg\":\"bad side\"}'}",
          '{"code": 1, "msg": "some msg"}', "{'code': 5, 'msg': 'nothing'}", "abc 1234567 def", '{"msg": "lower"}']
hum_bx = [[s, bx._humanize_bingx_error(s)] for s in HUM_BX]
HUM_BN = ["", "{'code': -2010, 'msg': 'x'}", '{"code": -2010, "msg": "Insufficient"}', '{"code": -9999, "msg": "weird thing"}', '{"code": -9999}', "x"]
hum_bn = [[s, bn._humanize_binance_error(s)] for s in HUM_BN]
HUM_OK = ["", "code 51004", "{'code': '50011'}", "plain error", "x" * 400]
hum_ok = [[s, ok._humanize_okx_error(s)] for s in HUM_OK]
SYMS = ["BTC-USDT-SWAP", "ETH-USDT", "BTCUSDT", "PEPE-USDT-SWAP", "SHIB-USDT-SWAP", "SATS-USDT-SWAP", "TON-USDT-SWAP",
        "LUNA-USDT-SWAP", "FLOKI-USDT-SWAP", "BONK-USDT-SWAP", "TURBO-USDT-SWAP", "BABYDOGE-USDT-SWAP", "MOG-USDT-SWAP",
        "1000PEPEUSDT", "SHIB1000USDT", "btc-usdt-swap", "DOGE", "XEC-USDT-SWAP", "CATS-USDT-SWAP", "LUNC-USDT-SWAP", "USDTUSDT"]
symbols = [[s, by.to_bybit_symbol(s), by.bybit_price_multiplier(s), bx.to_bingx_symbol(s), bx.bingx_price_multiplier(s),
            bn.to_binance_symbol(s), bn.binance_price_multiplier(s), ok.to_okx_symbol(s)] for s in SYMS]

out = {
    "step_decimals": step_dec, "round_qty": qty_cases, "round_price": price_cases, "fmt_price_display": disp_cases,
    "client_order_ids": cids, "fit_partial_split": fits, "min_notional": min_notional,
    "is_retryable_error": retryable, "is_transient_error": transient, "is_user_facing_error": user_facing,
    "is_auth_failure": auth_fail, "result_is_retryable": result_retry,
    "json_repr": reprs, "str_repr": str_reprs, "quote": quotes, "urlencode": urlencs, "float_parse": floats,
    "pow_ticks": pow_ticks,
    "bybit_sign": by_sig, "bingx_sign": bx_sig, "bingx_build_query": {"qs": bq[0], "headers": bq[1]},
    "binance_build_query": [{"qs": nq[0], "headers": nq[1]}, {"qs": nq2[0], "headers": nq2[1]}],
    "okx_iso_ts": [okx_ts, okx_ts_off], "okx_sign": okx_sig,
    "keys": {"key": KEY, "secret": SECRET},
    "humanize_bybit": hum_by, "humanize_bingx": hum_bx, "humanize_binance": hum_bn, "humanize_okx": hum_ok,
    "symbols": symbols,
}


def _clean(o):
    if isinstance(o, float):
        if o != o:
            return {"__float__": "nan"}
        if o in (float("inf"), float("-inf")):
            return {"__float__": "inf" if o > 0 else "-inf"}
        return o
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    return o


with open(OUT, "w", encoding="utf-8") as f:
    json.dump(_clean(out), f, ensure_ascii=False, indent=0)
print("wrote", OUT, {k: (len(v) if isinstance(v, list) else 1) for k, v in out.items()})
