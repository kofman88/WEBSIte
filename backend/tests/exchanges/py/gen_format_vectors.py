"""format_trade_result (all four traders) + bybit format_trade_result_split → ../fixtures/format_vectors.json.

  cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \
    $VENV/bin/python /path/to/backend/tests/exchanges/py/gen_format_vectors.py; rm -f signal_registry.json

Numbers that the bot holds as floats are kept non-integral (or are risk_pct / prices, which
the JS side renders as Python floats) so the JSON round trip cannot change their str().
"""
import json
import os
import sys

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
sys.path.insert(0, BOT)
os.chdir(BOT)

import bybit_trader as by  # noqa: E402
import bingx_trader as bx  # noqa: E402
import binance_trader as bn  # noqa: E402
import okx_trader as ok  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

RESULTS = [
    {"ok": True, "order_id": "1234567890", "qty": 0.011, "tp_placed": True, "notional": 957.25, "balance": 1000.5, "symbol": "BTCUSDT"},
    {"ok": True, "order_id": "abc<&>", "qty": "0.010", "tp_placed": False, "notional": 870.1, "balance": 250.75,
     "order_type": "Market", "avg_price": 87012.3},
    {"ok": True, "order_id": "x", "qty": 12000.5, "tp_placed": True, "order_type": "market", "avg_price": 0},
    {"ok": True, "order_id": "777", "qty": "1500", "symbol": "1000PEPE-USDT", "order_id_lo": "lo1", "order_id_hi": "hi2", "tp_placed": True,
     "notional": 18.45, "balance": 99.99},
    {"ok": False, "error": "Недостаточно средств <b>&</b> (110007)"},
    {"ok": False, "error": "Retryable error occurred, retrying... " + "x" * 300},
    {"ok": False},
    {"ok": False, "error": "SL-ордер не выставлен после 3 попыток.", "insufficient_margin": True},
]
CASES = [
    ("LONG", "BTC-USDT-SWAP", 87000.5, 86000.0, 88500.0, 1.0, 10, 89500.0, 90500.0),
    ("SHORT", "ETH-USDT-SWAP", 3000.25, 3060.0, 2900.0, 2.5, 20, 0.0, 0.0),
    ("LONG", "PEPE-USDT-SWAP", 0.0000123, 0.0000118, 0.0000131, 0.5, 5, 0.0000139, 0.0),
    ("BUY", "SOLUSDT", 150.123456789, 145.0, 160.0, 1.25, 3, 165.5, 170.75),
]

rows = []
for res in RESULTS:
    for d, s, e, sl, t1, rp, lev, t2, t3 in CASES:
        args = [res, d, s, e, sl, t1, rp, lev, t2, t3]
        row = {"args": args}
        for name, mod in (("bybit", by), ("bingx", bx), ("binance", bn), ("okx", ok)):
            try:
                row[name] = mod.format_trade_result(*args)
            except Exception as ex:  # noqa: BLE001
                row[name] = {"raised": type(ex).__name__, "msg": str(ex)}
        try:
            row["bybit_split"] = by.format_trade_result_split(res, d, s, e * 0.995, e * 1.005, sl, t1, rp, lev, t2, t3)
        except Exception as ex:  # noqa: BLE001
            row["bybit_split"] = {"raised": type(ex).__name__, "msg": str(ex)}
        row["split_args"] = [res, d, s, e * 0.995, e * 1.005, sl, t1, rp, lev, t2, t3]
        rows.append(row)

with open(os.path.join(HERE, "..", "fixtures", "format_vectors.json"), "w", encoding="utf-8") as f:
    json.dump(rows, f, ensure_ascii=False, indent=1)
print("wrote", len(rows))
