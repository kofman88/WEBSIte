"""gen_partial_tp_vectors.py — wire-level vectors for partial_tp.place_partial_tp_orders (M13b).

The bot's partial TP ladder runs on the bot's REAL traders through the exchange replay harness
(backend/tests/exchanges/py/harness.py: scripted HTTP per (method, path), real pybit over a fake
requests.Session or the dict session stand-in, fake clock — asyncio.sleep advances it instantly).
Recorded per scenario: the return value, every HTTP / pybit request exactly as sent (URL, auth
headers, body), sleeps, trader log markers, and the partial-TP side: its INFO+ log lines,
Telegram messages (ladder downgrade), enqueue_critical and admin alerts (both faked).

Output: backend/tests/autotrade/core/fixtures/partial_tp_vectors.json
  cd /home/user/MAIN_BOT/CHM_BREAKER_V4
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 $PY311 -I -B <worktree>/backend/tests/autotrade/core/gen/gen_partial_tp_vectors.py
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import json
import logging
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXCH_PY = os.path.normpath(os.path.join(HERE, "..", "..", "..", "exchanges", "py"))
OUT = os.path.normpath(os.path.join(HERE, "..", "fixtures", "partial_tp_vectors.json"))
sys.path.insert(0, EXCH_PY)
sys.dont_write_bytecode = True

import harness  # noqa: E402  (chdir to the bot, imports the four traders)
import scen_bybit as SB  # noqa: E402
import scen_bingx as SX  # noqa: E402
import scen_binance as SN  # noqa: E402
import scen_okx as SO  # noqa: E402

import partial_tp  # noqa: E402
import admin_alerts  # noqa: E402
import notification_queue  # noqa: E402

SIDE: dict = {}


class _Cap(logging.Handler):
    def emit(self, r):
        if r.levelno < logging.INFO or "logs" not in SIDE:
            return
        try:
            msg = r.getMessage()
        except Exception:  # noqa: BLE001
            msg = str(r.msg)
        if msg.startswith("[TG-SAFE]"):
            return
        SIDE["logs"].append([r.levelname, msg])


logging.getLogger().addHandler(_Cap())
logging.getLogger().setLevel(logging.INFO)


class FakeBot:
    async def send_message(self, chat_id, text, **kw):
        SIDE["msgs"].append([chat_id, text, kw.get("parse_mode")])
        if SIDE.get("send_fail"):
            raise RuntimeError("send failed")
        return True


async def _fake_alert(bot, title, details, dedup_key, alert_type=""):
    SIDE["alerts"].append([title, details, dedup_key, alert_type])


async def _fake_enqueue(bot, user_id, text, *, parse_mode="HTML", reason=""):
    SIDE["enqueue"].append([user_id, text, parse_mode, reason])
    return "q1"


admin_alerts.send_admin_alert = _fake_alert
notification_queue.enqueue_critical = _fake_enqueue


def _ptp_entry(**kw):
    async def run():
        partial_tp.asyncio = harness.by.asyncio      # the clock proxy run_scenario installed
        SIDE.clear()
        SIDE.update(logs=[], msgs=[], alerts=[], enqueue=[], send_fail=kw.pop("send_fail", False))
        user = type("U", (), dict(kw.pop("user")))()
        bot = FakeBot() if kw.pop("bot", False) else None
        try:
            v = {"ok": await partial_tp.place_partial_tp_orders(user=user, bot=bot, **kw)}
        except Exception as e:  # noqa: BLE001
            v = {"raised": [type(e).__name__, str(e)]}
        out = {"value": v, "logs": SIDE["logs"], "msgs": SIDE["msgs"], "alerts": SIDE["alerts"], "enqueue": SIDE["enqueue"]}
        SIDE.clear()
        return out
    return run()


for _m in (harness.by, harness.bx, harness.bn, harness.ok):
    _m.__ptp__ = _ptp_entry

SCENARIOS: list = []
USER = {"user_id": 501, "lang": "ru", "partial_tp_enabled": 1, "partial_tp1_r": 1.0, "partial_tp1_pct": 50.0,
        "partial_tp2_r": 1.5, "partial_tp2_pct": 30.0}


def S(name, ex, routes, mode="wire", user=None, state=None, **kw):
    k = {"api_key": {"bybit": SB.KEY, "bingx": SX.KEY, "binance": SN.KEY, "okx": SO.KEY}[ex],
         "api_secret": {"bybit": SB.SEC, "bingx": SX.SEC, "binance": SN.SEC, "okx": SO.SEC}[ex],
         "symbol": "BTC-USDT-SWAP", "entry": 87000.5, "sl": 86000.0, "direction": "LONG", "total_qty": 0.02,
         "strategy_name": "LEVELS", "exchange": ex, "bybit_demo": False, "pos_idx": 0, "bot": True,
         "tp1_signal_price": 88000.5, "tp2_signal_price": 89000.5}
    k.update(kw)
    k["user"] = {**USER, **(user or {})}
    SCENARIOS.append({"name": name, "exchange": ex, "call": "__ptp__", "args": [], "kwargs": k, "routes": routes,
                      "state": state or {}, "mode": mode, "random": [], "clock": 1767225600.0})


# ── Bybit (real pybit over the fake requests session) ──
BR = SB.R
BT = BR("GET", "/v5/market/time", SB.T)
BI = BR("GET", "/v5/market/instruments-info", SB.instr())
BP = BR("GET", "/v5/position/list", SB.positions(size="0.02"))
BO = BR("POST", "/v5/order/create", SB.order_ok("ptp-1"), SB.order_ok("ptp-2"))
S("bybit_sig_prices", "bybit", [BT, BI, BP, BO])
S("bybit_disabled", "bybit", [BT], user={"partial_tp_enabled": 0})
S("bybit_bad_inputs", "bybit", [BT], total_qty=0.0)
S("bybit_slip_recalc", "bybit", [BT, BI, BR("GET", "/v5/position/list", SB.positions(size="0.02", avg="87400.5")), BO],
  tp1_signal_price=0.0, tp2_signal_price=0.0)
S("bybit_r_multiples_no_slip", "bybit", [BT, BI, BP, BO], tp1_signal_price=0.0, tp2_signal_price=0.0)
S("bybit_sig_invalid_order", "bybit", [BT, BI, BP, BO], tp1_signal_price=89000.5, tp2_signal_price=88000.5)
S("bybit_safety_guard_tp1", "bybit", [BT, BI, BR("GET", "/v5/position/list", SB.positions(size="0.02", avg="88100.5")), BO])
S("bybit_skip_tp1_replace", "bybit", [BT, BI, BP, BO], skip_tp1=True)
S("bybit_short", "bybit", [BT, BI, BR("GET", "/v5/position/list", SB.positions(size="0.02", side="Sell")), BO],
  direction="SHORT", sl=88000.0, tp1_signal_price=86000.5, tp2_signal_price=85000.5)
S("bybit_position_closed_precheck", "bybit", [BT, BI, BR("GET", "/v5/position/list", SB.positions(size="0")), BO])
S("bybit_preflight_clamp", "bybit", [BT, BI, BR("GET", "/v5/position/list", SB.positions(size="0.02"), SB.positions(size="0.02"),
                                                 SB.positions(size="0.02"), SB.positions(size="0.004")), BO])
S("bybit_110017_race", "bybit", [BT, BI, BP, BR("POST", "/v5/order/create", SB.err(110017, "current position is zero, cannot fix reduce-only order qty"))])
S("bybit_reject_all_alert", "bybit", [BT, BI, BP, BR("POST", "/v5/order/create", SB.err(10001, "params error: price invalid"))])
S("bybit_reject_all_pos_closed", "bybit", [BT, BI, BR("GET", "/v5/position/list", SB.positions(size="0.02"), SB.positions(size="0.02"),
                                                       SB.positions(size="0.02"), SB.positions(size="0.02"), SB.positions(size="0")),
                                           BR("POST", "/v5/order/create", SB.err(10001, "params error"))])
S("bybit_truncated_notional", "bybit", [BT, BI, BP, BR("POST", "/v5/order/create", SB.err(110017, "orderQty will be truncated to zero"))])
S("bybit_notional_guard_consolidate", "bybit", [BT, BR("GET", "/v5/market/instruments-info", SB.instr(step="1", tick="0.0001")),
                                               BR("GET", "/v5/position/list", SB.positions(sym="ADAUSDT", size="23", avg="0.25")), BO],
  symbol="ADA-USDT-SWAP", entry=0.25, sl=0.24, total_qty=23.0, tp1_signal_price=0.26, tp2_signal_price=0.27)
S("bybit_notional_guard_skip", "bybit", [BT, BR("GET", "/v5/market/instruments-info", SB.instr(step="1", tick="0.0001")),
                                        BR("GET", "/v5/position/list", SB.positions(sym="ADAUSDT", size="8", avg="0.25")), BO],
  symbol="ADA-USDT-SWAP", entry=0.25, sl=0.24, total_qty=8.0, tp1_signal_price=0.26, tp2_signal_price=0.27)
S("bybit_1000x_pmult", "bybit", [BT, BR("GET", "/v5/market/instruments-info", SB.instr(step="100", tick="0.0000001")),
                                BR("GET", "/v5/position/list", SB.positions(sym="1000PEPEUSDT", size="200000", avg="0.0105")), BO],
  symbol="PEPE-USDT-SWAP", entry=0.0000105, sl=0.0000100, total_qty=200000.0, tp1_signal_price=0.0000110, tp2_signal_price=0.0000115)
S("bybit_demo_quirk", "bybit", [BT, BI, BP, BO], bybit_demo=True)
S("bybit_hedge_pos_idx", "bybit", [BT, BI, BR("GET", "/v5/position/list", SB.positions(size="0.02", idx=1)), BO], pos_idx=1)
S("bybit_pct_clamp", "bybit", [BT, BI, BP, BO], user={"partial_tp1_pct": 70.0, "partial_tp2_pct": 50.0})
S("bybit_session_mode", "bybit", [BT, SB.SC("get_instruments_info", SB.instr()), SB.SC("get_positions", SB.positions(size="0.02")),
                                 SB.SC("place_order", SB.order_ok("s-1"), SB.err(110017, "current position is zero"), SB.order_ok("s-2"))],
  mode="session")

# ── BingX ──
XR = SX.R
XC = SX.C
XP = XR("GET", "/openApi/swap/v2/user/positions", SX.pos(amt="0.02"))
XO = XR("POST", "/openApi/swap/v2/trade/order", SX.order("bx-tp1"), SX.order("bx-tp2"))
S("bingx_sig_prices", "bingx", [XC, XP, XO])
S("bingx_110413_retry", "bingx", [XC, XP, XR("POST", "/openApi/swap/v2/trade/order", SX.err(110413, "TP price should be greater than the current price"),
                                                SX.order("bx-tp1"), SX.order("bx-tp2")),
                                  XR("GET", "/openApi/swap/v2/quote/price", SX.price("88100.0"))])
S("bingx_110414_no_price", "bingx", [XC, XP, XR("POST", "/openApi/swap/v2/trade/order", SX.err(110414, "TP price should be lower"),
                                                   SX.err(110414, "TP price should be lower"), SX.err(110414, "TP price should be lower")),
                                     XR("GET", "/openApi/swap/v2/quote/price", SX.err(100400, "bad"))])
S("bingx_ladder_downgrade", "bingx", [XC, XR("GET", "/openApi/swap/v2/user/positions", SX.pos(sym="TONCOIN-USDT", amt="4", avg="3.1")), XO],
  symbol="TON-USDT-SWAP", entry=3.1, sl=3.0, total_qty=4.0, tp1_signal_price=3.2, tp2_signal_price=3.3)
S("bingx_ladder_downgrade_send_fail", "bingx", [XC, XR("GET", "/openApi/swap/v2/user/positions", SX.pos(sym="TONCOIN-USDT", amt="4", avg="3.1")), XO],
  symbol="TON-USDT-SWAP", entry=3.1, sl=3.0, total_qty=4.0, tp1_signal_price=3.2, tp2_signal_price=3.3, send_fail=True)
S("bingx_reject_all_alert", "bingx", [XC, XP, XR("POST", "/openApi/swap/v2/trade/order", SX.err(80001, "request failed"))])
S("bingx_no_bot_alert_skipped", "bingx", [XC, XP, XR("POST", "/openApi/swap/v2/trade/order", SX.err(80001, "request failed"))], bot=False)

# ── Binance ──
NR = SN.R
NI = SN.I
NP = NR("GET", "/fapi/v2/positionRisk", SN.pos(amt="0.020"))
NO = NR("POST", "/fapi/v1/order", SN.order(5001, type="TAKE_PROFIT_MARKET"), SN.order(5002, type="TAKE_PROFIT_MARKET"))
S("binance_sig_prices", "binance", [NI, NP, NO])
S("binance_code_negative", "binance", [NI, NP, NR("POST", "/fapi/v1/order", SN.err(-2021, "Order would immediately trigger."))])
S("binance_quirk_ok_without_order_id", "binance", [NI, NP, NR("POST", "/fapi/v1/order", {"json": {"code": 200, "msg": "accepted"}})])
S("binance_slip_recalc_short", "binance", [NI, NR("GET", "/fapi/v2/positionRisk", [{"symbol": "BTCUSDT", "positionAmt": "-0.020", "entryPrice": "86500.5",
                                                                                     "markPrice": "86400", "leverage": "10", "positionSide": "SHORT"}]), NO],
  direction="SHORT", sl=88000.0, tp1_signal_price=0.0, tp2_signal_price=0.0)

# ── OKX ──
OR = SO.R
OI = SO.I
OP = OR("GET", "/api/v5/account/positions", SO.pos(p="2"))
OO = OR("POST", "/api/v5/trade/order", SO.ORDER_OK)
S("okx_sig_prices", "okx", [OI, OP, OO], user={"okx_passphrase": SO.PP})
S("okx_retry_then_fail", "okx", [OI, OP, OR("POST", "/api/v5/trade/order", SO.err("1", "Operation failed.", [{"sCode": "51008", "sMsg": "Insufficient margin"}]))],
  user={"okx_passphrase": SO.PP})
S("okx_kwarg_passphrase", "okx", [OI, OP, OO], passphrase=SO.PP)


def _freeze(sc):
    out = dict(sc)
    routes = []
    for r in sc.get("routes", []):
        rr = dict(r)
        resps = []
        for x in r["responses"]:
            x = dict(x)
            if "json" in x:
                x["text"] = json.dumps(x.pop("json"))
            resps.append(x)
        rr["responses"] = resps
        routes.append(rr)
    out["routes"] = routes
    return out


def main():
    rows = []
    for sc in SCENARIOS:
        frozen = _freeze(sc)
        res = harness.run_scenario(json.loads(json.dumps(frozen)))
        rows.append({"scenario": frozen, "expected": res})
        v = (res.get("result") or {}).get("value") if isinstance(res.get("result"), dict) else res.get("raised")
        print(f"{sc['exchange']:8s} {sc['name']:36s} {v} reqs={len(res['requests'])}", file=sys.stderr)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    print(f"wrote {len(rows)} → {OUT}", file=sys.stderr)


main()
sys.stderr.flush()
os._exit(0)
