"""Adversarial randomized parity scenarios for the four traders (seeded, re-runnable).

  cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \
    $VENV/bin/python /path/to/backend/tests/exchanges/py/gen_adversarial.py; rm -f signal_registry.json

Per exchange: 30 random order scenarios (direction, Market/Limit, risk modes, qty-precision
edge cases placed right at qtyStep boundaries, 1000x/10000x symbols, hedge vs one-way, SL/TP
ladders, Bybit split entry, close/cancel/trailing/breakeven) and 10 recorded error replays
(rate limits, auth failures, benign codes 34040/10001/-4061/-4028/109400/51000 …) — 160 rows.

Everything harness.py records is kept (requests, result/raise, sleeps, markers, metrics,
events, caches) plus, through wire.py, each request as the REAL aiohttp / requests client
put it on the wire (method, request-target, headers, body) and the full header set the
trader passed. fixtures/adversarial_<exchange>.json is replayed by adversarial.test.js.
"""
from __future__ import annotations

import json
import math
import os
import random
import sys
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import harness  # noqa: E402
import wire  # noqa: E402
from gen_trader_scenarios import _freeze_routes  # noqa: E402

by, bx, bn, ok = harness.by, harness.bx, harness.bn, harness.ok

SEED = 20261008
N_ORDER = 30
N_ERROR = 10

SYMS = [
    ("BTC-USDT-SWAP", 87000.0), ("ETH-USDT-SWAP", 3000.0), ("SOL-USDT-SWAP", 150.0), ("XRP-USDT-SWAP", 2.5),
    ("DOGE-USDT-SWAP", 0.18), ("PEPE-USDT-SWAP", 0.0000123), ("SHIB-USDT-SWAP", 0.0000221),
    ("BONK-USDT-SWAP", 0.0000301), ("FLOKI-USDT-SWAP", 0.000141), ("TON-USDT-SWAP", 5.2),
    ("LUNC-USDT-SWAP", 0.000091), ("SATS-USDT-SWAP", 0.00000031), ("XEC-USDT-SWAP", 0.000033),
    ("1000PEPE-USDT-SWAP", 0.0123), ("PEPEUSDT", 0.0000123), ("ETHUSDT", 3000.0), ("WIF-USDT-SWAP", 1.9),
]
SL_DIST = [0.0004, 0.001, 0.0025, 0.005, 0.01, 0.02, 0.035, 0.06, 0.1]
RISKS = [0.1, 0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0]
LEVS = [1, 2, 3, 5, 7, 10, 20, 25, 50, 75, 100, 125, 150]


class Gen:
    def __init__(self, seed):
        self.r = random.Random(seed)

    def choice(self, xs):
        return self.r.choice(xs)

    def chance(self, p):
        return self.r.random() < p

    def key(self, prefix):
        al = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789"
        return prefix + "".join(self.r.choice(al) for _ in range(self.r.randint(10, 24)))

    def clock(self):
        return round(1767225600.0 + self.r.uniform(0, 86400 * 60), self.r.choice([0, 3, 4, 6]))

    def price(self, base):
        p = base * self.r.uniform(0.9, 1.1)
        sig = self.r.randint(3, 9)
        nd = max(0, sig - int(math.floor(math.log10(p))) - 1)
        return round(p, nd), nd

    def order_params(self, symbol=None):
        sym, base = symbol or self.choice(SYMS)
        direction = self.choice(["LONG", "SHORT"])
        entry, nd = self.price(base)
        d = self.choice(SL_DIST)
        sgn = 1 if direction == "LONG" else -1
        sl = round(entry * (1 - sgn * d), nd + 1)
        tp1 = round(entry * (1 + sgn * d * self.choice([0.5, 1.0, 1.5, 2.0])), nd + 1)
        tp2 = round(entry * (1 + sgn * d * self.choice([2.5, 3.0])), nd + 1) if self.chance(0.6) else 0.0
        tp3 = round(entry * (1 + sgn * d * self.choice([4.0, 5.0])), nd + 1) if (tp2 and self.chance(0.6)) or self.chance(0.1) else 0.0
        return {
            "symbol": sym, "direction": direction, "entry": entry, "sl": sl, "tp1": tp1, "tp2": tp2, "tp3": tp3,
            "risk_pct": self.choice(RISKS), "leverage": self.choice(LEVS),
            "risk_mode": self.r.choices(["risk", "notional", "margin"], [70, 15, 15])[0],
            "order_type": self.choice(["Limit", "Market"]),
            "trade_id": self.choice(["", "", f"t-{self.r.randrange(10**6)}", f"{self.r.randrange(10**12)}"]),
            "user_id": self.choice([0, self.r.randrange(1, 10**9)]),
            "boost": self.chance(0.3),
        }

    def step_for(self, qty_est):
        """A plausible lot step around the estimated qty (Decimal string), incl. odd ones."""
        if self.chance(0.08):
            return self.choice(["2.64", "0.0005", "0.25", "7"])
        e = int(math.floor(math.log10(max(qty_est, 1e-12))))
        exp = e - self.choice([0, 1, 1, 2, 2, 3])
        mant = self.choice([1, 1, 1, 2, 5])
        return _dec(Decimal(mant) * (Decimal(10) ** exp))

    def tick_for(self, price):
        e = int(math.floor(math.log10(price)))
        exp = e - self.choice([2, 3, 3, 4, 5, 6])
        mant = self.choice([1, 1, 1, 5])
        return _dec(Decimal(mant) * (Decimal(10) ** exp))

    def balance_for(self, p, mult, step, lev):
        """Equity making qty land on (or a hair off) a step boundary for risk mode, else random."""
        dist = abs(p["entry"] - p["sl"]) * mult
        if p["risk_mode"] == "risk" and dist > 0 and self.chance(0.45):
            n = self.r.randint(1, 60)
            eps = self.choice([-1e-12, -1e-9, 0.0, 1e-12, 1e-9, -3e-16])
            target = n * float(step) * (1 + eps)
            bal = target * dist * 100.0 / p["risk_pct"]
            if 20.0 <= bal <= 5e6:
                return float(repr(bal)), True
        return self.choice([25.0, 80.5, 150.0, 500.0, 1234.56, 5000.0, 20000.0, 98765.4321]), False


def _safe(p, lev=10):
    p.update(risk_pct=1.0, leverage=lev, risk_mode="risk")
    return p


def _dec(d):
    s = format(d.normalize(), "f")
    return s


def _qty_est(p, mult, bal):
    dist = abs(p["entry"] - p["sl"]) * mult
    risk_usd = bal * p["risk_pct"] / 100.0
    if p["risk_mode"] == "notional":
        return risk_usd / (p["entry"] * mult)
    if p["risk_mode"] == "margin":
        return risk_usd * min(p["leverage"], 100) / (p["entry"] * mult)
    return risk_usd / dist if dist else 1.0


def R(method, path, *resps, query=None):
    def spec(x):
        if isinstance(x, dict) and ("raise" in x or "json" in x or "text" in x or isinstance(x.get("status"), int)):
            return x
        return {"json": x}
    r = {"method": method, "path": path, "responses": [spec(x) for x in resps]}
    if query:
        r["query"] = query
    return r


def _fmt(x):
    return repr(float(x))


# ══ Bybit ═══════════════════════════════════════════════════════════════════

def bybit_rows(g: Gen):
    KEY, SEC = g.key("BB"), g.key("bs-")
    out = []

    def T(clock):
        return {"retCode": 0, "retMsg": "OK", "result": {"timeSecond": str(int(clock)), "timeNano": str(int(clock * 1e9))}}

    def ok_(res=None):
        return {"retCode": 0, "retMsg": "OK", "result": res or {}}

    def err(code, msg):
        return {"retCode": code, "retMsg": msg, "result": {}}

    def wallet(total, avail, coin_avail=""):
        return ok_({"list": [{"totalEquity": total, "totalAvailableBalance": avail, "totalWalletBalance": total,
                              "totalUnrealisedPnl": "0.5", "coin": [{"coin": "USDT", "walletBalance": total, "equity": total,
                                                                      "availableBalance": coin_avail, "availableToWithdraw": ""}]}]})

    def instr(step, tick):
        return ok_({"list": [{"lotSizeFilter": {"qtyStep": step}, "priceFilter": {"tickSize": tick}}]})

    def order(oid):
        return ok_({"orderId": oid, "orderLinkId": ""})

    def positions(sym, size, idx, avg, side):
        return ok_({"list": [{"symbol": sym, "side": side, "size": size, "positionIdx": idx, "avgPrice": avg,
                              "markPrice": avg, "stopLoss": ""}]})

    def tick_resp(sym, mark):
        return ok_({"list": [{"symbol": sym, "markPrice": mark, "lastPrice": mark, "bid1Price": mark, "ask1Price": mark, "fundingRate": "0.0001"}]})

    def S(name, call, args, kwargs, routes, state=None, clock=None, random_=None):
        out.append({"name": name, "exchange": "bybit", "call": call, "args": args, "kwargs": kwargs, "routes": routes,
                    "state": state or {}, "mode": "wire", "random": random_ or [g.r.random() for _ in range(4)],
                    "clock": clock if clock is not None else g.clock()})

    def flow(p, *, split=False, clock=None, safe=False):
        """Common route set for a Bybit place_trade / place_trade_split."""
        bb = by.to_bybit_symbol(p["symbol"])
        mult = by.bybit_price_multiplier(p["symbol"])
        bal0 = g.choice([500.0, 5000.0])
        step = g.step_for(_qty_est(p, mult, bal0))
        bal, edge = g.balance_for(p, mult, step, p["leverage"])
        tick = g.tick_for(p["entry"] * mult)
        avail = bal * g.choice([1.0, 1.0, 1.0, 0.9, 0.5, 0.05])
        acct = g.choice(["UNIFIED", "UNIFIED", "CONTRACT"])
        if safe:
            step, tick, bal, avail, acct, edge = "0.001", "0.1", 5000.0, 5000.0, "UNIFIED", False
        hedge = g.choice([None, True, False])
        idx = (1 if p["direction"] == "LONG" else 2) if hedge else 0
        side = "Buy" if p["direction"] == "LONG" else "Sell"
        qest = _qty_est(p, mult, bal)
        size = _dec(Decimal(repr(max(qest, float(step)))).quantize(Decimal(step) if "." in step else Decimal(1)))
        routes = [
            R("GET", "/v5/market/time", T(clock or 1767225600)),
            R("POST", "/v5/position/switch-isolated", g.choice([err(110026, "Cross/isolated margin mode is not modified"), ok_()])),
            R("POST", "/v5/position/set-leverage", g.choice([err(110043, "leverage not modified"), ok_()])),
            R("GET", "/v5/account/wallet-balance", *([err(10001, "accountType only support UNIFIED")] if acct == "CONTRACT" else []),
              wallet(_fmt(bal), _fmt(avail), _fmt(avail) if acct == "CONTRACT" else "")),
            R("GET", "/v5/market/instruments-info", instr(step, tick)),
            R("POST", "/v5/order/create", *[order(f"bb-{g.r.randrange(10**9)}") for _ in range(6)]),
            R("GET", "/v5/position/list", *([positions(bb, "0", idx, "0", side)] if g.chance(0.3) else []),
              positions(bb, size, idx, _fmt(p["entry"] * mult), side)),
            R("POST", "/v5/position/trading-stop", ok_()),
            R("GET", "/v5/order/realtime", ok_({"list": [{"symbol": bb, "reduceOnly": True, "orderType": "Limit", "side": "Sell" if side == "Buy" else "Buy"}] * g.choice([0, 1, 3])})),
        ]
        state = {}
        if acct == "CONTRACT":
            state["account_type"] = {KEY: "CONTRACT"}
        if hedge is not None:
            if g.chance(0.5):
                state["hedge"] = {KEY: hedge}
            else:
                state["kv_hedge"] = hedge
        if g.chance(0.4):
            state["time_offset_ms"] = g.r.randint(-2500, 2500)
        return routes, state, {"edge": edge, "step": step, "tick": tick}

    n_split = 5
    n_mgmt = 9
    for i in range(N_ORDER - n_split - n_mgmt):
        p = g.order_params()
        clock = g.clock()
        routes, state, meta = flow(p, clock=clock)
        kw = {"tp2": p["tp2"], "tp3": p["tp3"], "risk_mode": p["risk_mode"], "order_type": p["order_type"],
              "trade_id": p["trade_id"], "user_id": p["user_id"], "allow_low_notional_boost": p["boost"]}
        S(f"rnd_pt_{i:02d}_{p['symbol']}_{p['direction']}_{p['order_type']}_{p['risk_mode']}{'_edge' if meta['edge'] else ''}",
          "place_trade", [KEY, SEC, p["symbol"], p["direction"], p["entry"], p["sl"], p["tp1"], p["risk_pct"], p["leverage"]],
          kw, routes, state, clock)
    for i in range(n_split):
        p = g.order_params()
        clock = g.clock()
        routes, state, meta = flow(p, split=True, clock=clock)
        w = abs(p["entry"] - p["sl"]) * g.choice([0.2, 0.4, 0.6])
        lo, hi = sorted([p["entry"], round(p["entry"] - w if p["direction"] == "LONG" else p["entry"] + w, 12)])
        S(f"rnd_split_{i:02d}_{p['symbol']}_{p['direction']}", "place_trade_split",
          [KEY, SEC, p["symbol"], p["direction"], lo, hi, p["sl"], p["tp1"], p["risk_pct"], p["leverage"]],
          {"tp2": p["tp2"], "tp3": p["tp3"], "user_id": p["user_id"]}, routes, state, clock)
    mg = ["close", "close", "close", "cancel_all", "cancel_all", "trail", "trail", "trail", "breakeven"]
    for i, kind in enumerate(mg):
        p = g.order_params()
        bb = by.to_bybit_symbol(p["symbol"])
        mult = by.bybit_price_multiplier(p["symbol"])
        step = g.step_for(g.choice([0.001, 0.5, 30.0, 12345.0]))
        tick = g.tick_for(p["entry"] * mult)
        if kind == "close":
            side = g.choice(["LONG", "SHORT", "Buy", "Sell", "long"])
            size = g.choice([repr(float(step) * g.r.uniform(0.3, 40)), str(g.r.randint(1, 500)), repr(round(g.r.uniform(0.0001, 3), 5))])
            S(f"rnd_close_{i:02d}_{bb}_{side}", "close_position", [KEY, SEC, p["symbol"], side, size, g.choice([0, 1, 2])], {},
              [R("GET", "/v5/market/instruments-info", instr(step, tick)), R("POST", "/v5/order/create", order("cl-%d" % i))])
        elif kind == "cancel_all":
            S(f"rnd_cancel_all_{i:02d}_{bb}", "cancel_all_orders", [KEY, SEC, p["symbol"], g.chance(0.5)], {},
              [R("POST", "/v5/order/cancel-all", ok_({"list": [{"orderId": str(k)} for k in range(g.r.randint(0, 4))]}))])
        elif kind == "trail":
            mark = p["entry"] * mult * g.r.uniform(0.97, 1.03)
            new_sl = round(p["sl"] * g.r.uniform(0.995, 1.005), 12)
            S(f"rnd_trail_{i:02d}_{bb}_{p['direction']}", "set_trailing_sl",
              [KEY, SEC, p["symbol"], new_sl, p["direction"], g.choice([0, 1, 2]), g.chance(0.3)], {},
              [R("GET", "/v5/market/instruments-info", instr(step, tick)),
               R("GET", "/v5/market/tickers", tick_resp(bb, _fmt(mark))),
               R("POST", "/v5/position/trading-stop", ok_())])
        else:
            S(f"rnd_be_{i:02d}_{bb}_{p['direction']}", "set_breakeven",
              [KEY, SEC, p["symbol"], p["entry"], p["direction"], g.choice([0, 1, 2])], {},
              [R("GET", "/v5/market/instruments-info", instr(step, tick)), R("POST", "/v5/position/trading-stop", ok_())])

    # ── recorded error replays ──
    errs = [
        ("rate_limit_10006_order", "order", {"json": err(10006, "Too many visits!"), "headers": {"X-Bapi-Limit-Reset-Timestamp": "RESET"}}),
        ("http_429_wallet", "wallet", {"status": 429, "text": "Too Many Requests", "headers": {"Content-Type": "text/plain"}}),
        ("auth_10003_wallet", "wallet", err(10003, "API key is invalid.")),
        ("auth_10004_leverage", "leverage", err(10004, "error sign! origin_string[1767225600000BBKEY15000{}]")),
        ("benign_34040_trail", "trail", err(34040, "not modified")),
        ("benign_10001_close", "close", err(10001, "Qty invalid")),
        ("benign_34040_breakeven", "breakeven", err(34040, "not modified")),
        ("ts_10002_order", "order", err(10002, "invalid request, please check your server timestamp or recv_window param")),
        ("rate_limit_10006_cancel_all", "cancel_all", {"json": err(10006, "Too many visits!"), "headers": {"X-Bapi-Limit-Reset-Timestamp": "RESET"}}),
        ("benign_10001_instruments", "instruments", err(10001, "params error: symbol invalid")),
    ]
    for name, where, resp in errs:
        p = _safe(g.order_params(("BTC-USDT-SWAP", 87000.0)))
        clock = g.clock()
        resp = json.loads(json.dumps(resp).replace('"RESET"', '"%d"' % int(clock * 1000 + g.r.randint(200, 2500))))
        if where in ("order", "wallet", "leverage", "instruments"):
            routes, state, _ = flow(p, clock=clock, safe=True)
            target = {"order": "/v5/order/create", "wallet": "/v5/account/wallet-balance", "leverage": "/v5/position/set-leverage",
                      "instruments": "/v5/market/instruments-info"}[where]
            for r in routes:
                if r["path"] == target:
                    r["responses"] = [R("X", "", resp)["responses"][0]] + r["responses"][-1:]
            if where == "wallet" and "auth" in name:
                state["auth_uids"] = [g.r.randrange(1, 10**6), g.r.randrange(1, 10**6)]
            kw = {"tp2": p["tp2"], "tp3": p["tp3"], "risk_mode": p["risk_mode"], "order_type": p["order_type"],
                  "trade_id": p["trade_id"], "user_id": p["user_id"], "allow_low_notional_boost": p["boost"]}
            S(f"err_{name}", "place_trade", [KEY, SEC, p["symbol"], p["direction"], p["entry"], p["sl"], p["tp1"], p["risk_pct"], p["leverage"]],
              kw, routes, state, clock)
        elif where == "trail":
            S(f"err_{name}", "set_trailing_sl", [KEY, SEC, p["symbol"], p["sl"], p["direction"], 0], {},
              [R("GET", "/v5/market/instruments-info", instr("0.001", "0.1")),
               R("GET", "/v5/market/tickers", tick_resp("BTCUSDT", _fmt(p["entry"]))),
               R("POST", "/v5/position/trading-stop", resp)], clock=clock)
        elif where == "breakeven":
            S(f"err_{name}", "set_breakeven", [KEY, SEC, p["symbol"], p["entry"], p["direction"], 0], {},
              [R("GET", "/v5/market/instruments-info", instr("0.001", "0.1")), R("POST", "/v5/position/trading-stop", resp)], clock=clock)
        elif where == "close":
            S(f"err_{name}", "close_position", [KEY, SEC, p["symbol"], p["direction"], "0.0123", 0], {},
              [R("GET", "/v5/market/instruments-info", instr("0.001", "0.1")), R("POST", "/v5/order/create", resp)], clock=clock)
        elif where == "cancel_all":
            S(f"err_{name}", "cancel_all_orders", [KEY, SEC, p["symbol"]], {},
              [R("POST", "/v5/order/cancel-all", resp, ok_({"list": []}))], clock=clock)
    return out


# ══ BingX ═══════════════════════════════════════════════════════════════════

def bingx_rows(g: Gen):
    KEY, SEC = g.key("BX"), g.key("bxs-")
    out = []

    def ok_(data):
        return {"code": 0, "msg": "", "data": data}

    def err(code, msg):
        return {"code": code, "msg": msg, "data": {}}

    def oid():
        return g.choice([g.r.randrange(1, 10**6), 1735947220470939648 + g.r.randrange(10**6)])

    def order():
        return ok_({"order": {"orderId": oid(), "symbol": "X", "side": "BUY", "type": "LIMIT"}})

    def contracts(sym, step, prec, maxlev):
        rows = [{"symbol": "BTC-USDT", "tradeMinQuantity": 0.0001, "pricePrecision": 1, "maxLeverage": 125, "status": 1}]
        if sym != "BTC-USDT":
            rows.append({"symbol": sym, "tradeMinQuantity": step, "pricePrecision": prec, "maxLeverage": maxlev, "status": 1})
        else:
            rows[0] = {"symbol": sym, "tradeMinQuantity": step, "pricePrecision": prec, "maxLeverage": maxlev, "status": 1}
        return ok_(rows)

    def bal(eq):
        return ok_({"balance": {"userId": "1", "asset": "USDT", "balance": eq, "equity": eq, "unrealizedProfit": "0", "availableMargin": eq}})

    def pos(sym, amt, side, avg):
        return ok_([{"symbol": sym, "positionSide": side, "positionAmt": amt, "avgPrice": avg, "markPrice": avg,
                     "unrealizedProfit": "0.1", "leverage": 10, "stopLoss": ""}])

    def oo(*orders):
        return ok_({"orders": list(orders)})

    def S(name, call, args, kwargs, routes, state=None, clock=None):
        out.append({"name": name, "exchange": "bingx", "call": call, "args": args, "kwargs": kwargs, "routes": routes,
                    "state": state or {}, "random": [g.r.random() for _ in range(4)], "clock": clock if clock is not None else g.clock()})

    def num_step(step):
        f = float(step)
        return int(f) if f.is_integer() and g.chance(0.5) else f

    def flow(p, safe=False):
        sym = bx.to_bingx_symbol(p["symbol"])
        mult = bx.bingx_price_multiplier(p["symbol"])
        step = g.step_for(_qty_est(p, mult, 5000.0))
        bal_v, edge = g.balance_for(p, mult, step, p["leverage"])
        if safe:
            step, bal_v, edge = "0.0001", 5000.0, False
        prec = max(0, -int(math.floor(math.log10(p["entry"] * mult))) + g.choice([2, 3, 4, 5]))
        maxlev = g.choice([20, 50, 75, 125, "75"])
        hedge = g.chance(0.5)
        ps = ("LONG" if p["direction"] == "LONG" else "SHORT") if hedge else "BOTH"
        qest = _qty_est(p, mult, bal_v)
        amt = repr(max(qest, float(step)) * (1 if p["direction"] == "LONG" else -1))
        price_now = p["entry"] * mult * g.r.uniform(0.995, 1.005)
        close_side = "SELL" if p["direction"] == "LONG" else "BUY"
        tp_orders = [{"orderId": oid(), "type": "TAKE_PROFIT_MARKET", "side": close_side} for _ in range(g.choice([0, 1, 2, 3]))]
        routes = [
            R("GET", "/openApi/swap/v2/quote/contracts", contracts(sym, num_step(step), prec, maxlev)),
            R("GET", "/openApi/swap/v2/user/balance", bal(_fmt(bal_v))),
            R("POST", "/openApi/swap/v2/trade/leverage", *([] if hedge else [err(109400, "In One-way mode, side should be BOTH")]),
              ok_({"leverage": 10, "symbol": sym})),
            R("POST", "/openApi/swap/v2/trade/batchOrders", g.choice([err(100001, "Signature verification failed"),
                                                                     ok_({"orders": [{"orderId": oid()} for _ in range(5)]})])),
            R("GET", "/openApi/swap/v2/quote/price", ok_({"symbol": sym, "price": _fmt(price_now), "time": 1767225600000})),
            R("POST", "/openApi/swap/v2/trade/order", *[order() for _ in range(8)]),
            R("GET", "/openApi/swap/v2/user/positions", *([ok_([])] if g.chance(0.3) else []), pos(sym, amt, ps, _fmt(p["entry"] * mult))),
            R("GET", "/openApi/swap/v2/trade/openOrders", oo(*tp_orders)),
            R("DELETE", "/openApi/swap/v2/trade/allOpenOrders", ok_({"success": [], "orders": []})),
            R("DELETE", "/openApi/swap/v2/trade/order", ok_({})),
        ]
        state = {}
        if g.chance(0.5):
            state["bingx_offset_ms"] = g.r.randint(-3000, 3000)
        if g.chance(0.3):
            state["live_bingx"] = [sym, "BTC-USDT", "ETH-USDT"]
        return routes, state, edge, sym, step, prec

    n_mgmt = 12
    for i in range(N_ORDER - n_mgmt):
        p = g.order_params()
        routes, state, edge, sym, _, _ = flow(p)
        kw = {"tp2": p["tp2"], "tp3": p["tp3"], "risk_mode": p["risk_mode"], "order_type": p["order_type"],
              "trade_id": p["trade_id"], "user_id": p["user_id"], "allow_low_notional_boost": p["boost"]}
        S(f"rnd_pt_{i:02d}_{sym}_{p['direction']}_{p['order_type']}_{p['risk_mode']}{'_edge' if edge else ''}", "place_trade",
          [KEY, SEC, p["symbol"], p["direction"], p["entry"], p["sl"], p["tp1"], p["risk_pct"], p["leverage"]], kw, routes, state)
    mg = ["close", "close", "close", "cancel_all", "cancel_all", "trail", "trail", "trail", "breakeven", "breakeven", "sltp", "cancel_tp"]
    for i, kind in enumerate(mg):
        p = g.order_params()
        routes, state, _, sym, step, _ = flow(p)
        if kind == "close":
            side = g.choice(["LONG", "SHORT", "long", "short"])
            size = float(step) * g.r.uniform(0.3, 40)
            S(f"rnd_close_{i:02d}_{sym}_{side}", "close_position", [KEY, SEC, p["symbol"], side, size], {}, routes, state)
        elif kind == "cancel_all":
            S(f"rnd_cancel_all_{i:02d}_{sym}", "cancel_all_orders", [KEY, SEC, p["symbol"]], {}, routes, state)
        elif kind == "trail":
            S(f"rnd_trail_{i:02d}_{sym}_{p['direction']}", "set_trailing_sl", [KEY, SEC, p["symbol"], p["sl"], p["direction"], 0], {}, routes, state)
        elif kind == "breakeven":
            S(f"rnd_be_{i:02d}_{sym}_{p['direction']}", "set_breakeven", [KEY, SEC, p["symbol"], p["entry"], p["direction"], 0], {}, routes, state)
        elif kind == "sltp":
            S(f"rnd_sltp_{i:02d}_{sym}_{p['direction']}", "place_sl_tp_for_position",
              [KEY, SEC, p["symbol"], p["direction"], float(step) * 7, p["sl"], p["tp1"], p["tp2"], p["tp3"]], {}, routes, state)
        else:
            S(f"rnd_cancel_tp_{i:02d}_{sym}", "cancel_tp_orders_only", [KEY, SEC, p["symbol"]], {}, routes, state)

    errs = [
        ("benign_109400_leverage_oneway", "leverage", err(109400, "In One-way mode, side should be BOTH")),
        ("benign_109400_order_retry", "order", err(109400, "positionSide error")),
        ("auth_100413_balance", "balance", err(100413, "Incorrect apiKey")),
        ("auth_100001_balance", "balance", err(100001, "Signature verification failed")),
        ("http_429_order", "order", {"raise": "error", "message": "429, message='Too Many Requests', url='https://open-api.bingx.com/openApi/swap/v2/trade/order'"}),
        ("rate_100410_order", "order", err(100410, "frequency limit, please try again later")),
        ("benign_109400_trail", "trail", err(109400, "positionSide")),
        ("benign_109400_close", "close", err(109400, "positionSide")),
        ("rate_100410_cancel_all", "cancel_all", err(100410, "frequency limit")),
        ("sl_101400_retries", "order2", err(101400, "invalid stopPrice trigger")),
    ]
    for name, where, resp in errs:
        p = _safe(g.order_params(("BTC-USDT-SWAP", 87000.0)))
        routes, state, _, sym, step, _ = flow(p, safe=True)
        spec = R("X", "", resp)["responses"][0]
        path = {"leverage": "/openApi/swap/v2/trade/leverage", "order": "/openApi/swap/v2/trade/order", "order2": "/openApi/swap/v2/trade/order",
                "balance": "/openApi/swap/v2/user/balance", "trail": "/openApi/swap/v2/trade/order", "close": "/openApi/swap/v2/trade/order",
                "cancel_all": "/openApi/swap/v2/trade/allOpenOrders"}[where]
        for r in routes:
            if r["path"] == path and (where != "cancel_all" or r["method"] == "DELETE"):
                if where == "order2":
                    r["responses"] = [r["responses"][0], spec, spec, spec] + r["responses"][1:]
                else:
                    r["responses"] = [spec] + r["responses"][-1:]
        kw = {"tp2": p["tp2"], "tp3": p["tp3"], "risk_mode": "risk", "order_type": p["order_type"],
              "trade_id": p["trade_id"], "user_id": p["user_id"], "allow_low_notional_boost": True}
        if where in ("leverage", "order", "balance", "order2"):
            S(f"err_{name}", "place_trade", [KEY, SEC, p["symbol"], p["direction"], p["entry"], p["sl"], p["tp1"], p["risk_pct"], p["leverage"]],
              kw, routes, state)
        elif where == "trail":
            S(f"err_{name}", "set_trailing_sl", [KEY, SEC, p["symbol"], p["sl"], p["direction"], 0], {}, routes, state)
        elif where == "close":
            S(f"err_{name}", "close_position", [KEY, SEC, p["symbol"], p["direction"], float(step) * 3], {}, routes, state)
        else:
            S(f"err_{name}", "cancel_all_orders", [KEY, SEC, p["symbol"]], {}, routes, state)
    return out


# ══ Binance ═════════════════════════════════════════════════════════════════

def binance_rows(g: Gen):
    KEY, SEC = g.key("BN"), g.key("bns-")
    out = []

    def err(code, msg):
        return {"code": code, "msg": msg}

    def oid():
        return g.r.randrange(10**6, 10**10)

    def order(**kw):
        o = {"orderId": oid(), "symbol": "X", "status": "NEW", "clientOrderId": "x", "price": "0", "avgPrice": "0.00000",
             "origQty": "1", "executedQty": "0", "type": "MARKET"}
        o.update(kw)
        return o

    def info(sym, step, tick, bracket):
        s = {"symbol": sym, "status": "TRADING", "filters": [
            {"filterType": "PRICE_FILTER", "minPrice": "0", "maxPrice": "0", "tickSize": tick},
            {"filterType": "LOT_SIZE", "stepSize": step, "maxQty": "1000000", "minQty": step},
            {"filterType": "MIN_NOTIONAL", "notional": "5"}]}
        if bracket:
            s["leverageBracket"] = [{"initialLeverage": bracket}]
        return {"timezone": "UTC", "serverTime": 1767225600000, "symbols": [{"symbol": "BNBUSDT", "status": "TRADING", "filters": []}, s]}

    def bal(b):
        return [{"accountAlias": "Sg", "asset": "USDT", "balance": b, "crossWalletBalance": b, "crossUnPnl": "0.0",
                 "availableBalance": b, "maxWithdrawAmount": b}]

    def pos(sym, amt, side):
        return [{"symbol": sym, "positionAmt": amt, "entryPrice": "1.0", "markPrice": "1.0", "unRealizedProfit": "0.0",
                 "liquidationPrice": "0", "leverage": "10", "positionSide": side}]

    def S(name, call, args, kwargs, routes, state=None, clock=None):
        out.append({"name": name, "exchange": "binance", "call": call, "args": args, "kwargs": kwargs, "routes": routes,
                    "state": state or {}, "random": [g.r.random() for _ in range(6)], "clock": clock if clock is not None else g.clock()})

    def flow(p, safe=False):
        sym = bn.to_binance_symbol(p["symbol"])
        mult = bn.binance_price_multiplier(p["symbol"])
        step = g.step_for(_qty_est(p, mult, 5000.0))
        bal_v, edge = g.balance_for(p, mult, step, p["leverage"])
        tick = g.tick_for(p["entry"] * mult)
        if safe:
            step, tick, bal_v, edge = "0.001", "0.10", 5000.0, False
        dual = g.choice(["ok", "ok", "4059", "4061"])
        hedge = dual != "4061"
        ps = ("LONG" if p["direction"] == "LONG" else "SHORT") if hedge else "BOTH"
        qest = _qty_est(p, mult, bal_v)
        amt = repr(max(qest, float(step)) * (1 if p["direction"] == "LONG" else -1))
        price_now = p["entry"] * mult * g.r.uniform(0.995, 1.005)
        close_side = "SELL" if p["direction"] == "LONG" else "BUY"
        dual_resp = {"ok": {"code": 200, "msg": "success"}, "4059": err(-4059, "No need to change position side."),
                     "4061": err(-4061, "Position side cannot be changed if there exists position.")}[dual]
        batch = g.choice(["sig", "ok", "partial"])
        batch_resp = {"sig": err(-1022, "Signature for this request is not valid."),
                      "ok": [order(), order(type="STOP_MARKET"), order(type="TAKE_PROFIT_MARKET"), order(type="TAKE_PROFIT_MARKET"), order(type="TAKE_PROFIT_MARKET")],
                      "partial": [order(), err(-2021, "Order would immediately trigger.")]}[batch]
        routes = [
            R("GET", "/fapi/v1/exchangeInfo", info(sym, step, tick, g.choice([None, None, 20, 50]))),
            R("GET", "/fapi/v2/balance", bal(_fmt(bal_v))),
            R("POST", "/fapi/v1/positionSide/dual", dual_resp),
            R("POST", "/fapi/v1/leverage", {"leverage": 10, "maxNotionalValue": "1000000", "symbol": sym}),
            R("POST", "/fapi/v1/batchOrders", batch_resp),
            R("GET", "/fapi/v1/ticker/price", {"symbol": sym, "price": _fmt(price_now), "time": 1767225600000}),
            R("POST", "/fapi/v1/order", *[order() for _ in range(8)]),
            R("GET", "/fapi/v2/positionRisk", pos(sym, amt, ps)),
            R("GET", "/fapi/v1/openOrders", [{"orderId": oid(), "symbol": sym, "type": t, "side": close_side, "positionSide": ps,
                                              "price": "0", "origQty": "1", "stopPrice": "1"} for t in g.choice([[], ["STOP_MARKET"], ["STOP_MARKET", "TAKE_PROFIT_MARKET"]])]),
            R("DELETE", "/fapi/v1/order", order(status="CANCELED")),
            R("DELETE", "/fapi/v1/allOpenOrders", {"code": 200, "msg": "The operation of cancel all open order is done."}),
        ]
        state = {}
        if g.chance(0.5):
            state["binance_offset_ms"] = g.r.randint(-3000, 3000)
        return routes, state, edge, sym, step

    n_mgmt = 12
    for i in range(N_ORDER - n_mgmt):
        p = g.order_params()
        routes, state, edge, sym, _ = flow(p)
        kw = {"tp2": p["tp2"], "tp3": p["tp3"], "risk_mode": p["risk_mode"], "order_type": p["order_type"],
              "trade_id": p["trade_id"], "user_id": p["user_id"], "allow_low_notional_boost": p["boost"]}
        S(f"rnd_pt_{i:02d}_{sym}_{p['direction']}_{p['order_type']}_{p['risk_mode']}{'_edge' if edge else ''}", "place_trade",
          [KEY, SEC, p["symbol"], p["direction"], p["entry"], p["sl"], p["tp1"], p["risk_pct"], p["leverage"]], kw, routes, state)
    mg = ["close", "close", "close", "cancel_all", "cancel_all", "trail", "trail", "trail", "breakeven", "breakeven", "sltp", "cancel_tp"]
    for i, kind in enumerate(mg):
        p = g.order_params()
        routes, state, _, sym, step = flow(p)
        if kind == "close":
            side = g.choice(["LONG", "SHORT", "long", "short"])
            S(f"rnd_close_{i:02d}_{sym}_{side}", "close_position", [KEY, SEC, p["symbol"], side, float(step) * g.r.uniform(0.3, 40)], {}, routes, state)
        elif kind == "cancel_all":
            S(f"rnd_cancel_all_{i:02d}_{sym}", "cancel_all_orders", [KEY, SEC, p["symbol"]], {}, routes, state)
        elif kind == "trail":
            S(f"rnd_trail_{i:02d}_{sym}_{p['direction']}", "set_trailing_sl", [KEY, SEC, p["symbol"], p["sl"], p["direction"]], {}, routes, state)
        elif kind == "breakeven":
            S(f"rnd_be_{i:02d}_{sym}_{p['direction']}", "set_breakeven", [KEY, SEC, p["symbol"], p["entry"], p["direction"]], {}, routes, state)
        elif kind == "sltp":
            S(f"rnd_sltp_{i:02d}_{sym}_{p['direction']}", "place_sl_tp_for_position",
              [KEY, SEC, p["symbol"], p["direction"], float(step) * 7, p["sl"], p["tp1"], p["tp2"], p["tp3"]], {}, routes, state)
        else:
            S(f"rnd_cancel_tp_{i:02d}_{sym}", "cancel_tp_orders_only", [KEY, SEC, p["symbol"]], {}, routes, state)

    errs = [
        ("benign_4061_dual", "dual", err(-4061, "Position side cannot be changed if there exists position.")),
        ("benign_4028_leverage", "leverage", err(-4028, "Leverage 150 is not valid")),
        ("auth_2015_balance", "balance", err(-2015, "Invalid API-key, IP, or permissions for action.")),
        ("rate_1003_order", "order", err(-1003, "Too many requests; current limit is 2400 requests per minute.")),
        ("http_429_order", "order", {"status": 429, "json": err(-1003, "Too many requests; please use the websocket for live updates."), "headers": {"Retry-After": "7"}}),
        ("http_418_balance", "balance", {"status": 418, "text": "", "headers": {"Content-Type": "text/html"}}),
        ("auth_1022_order", "order", err(-1022, "Signature for this request is not valid.")),
        ("reduce_2022_close", "close", err(-2022, "ReduceOnly Order is rejected.")),
        ("benign_4061_order_trail", "trail", err(-4061, "Order's position side does not match user's setting.")),
        ("benign_4059_dual", "dual", err(-4059, "No need to change position side.")),
    ]
    for name, where, resp in errs:
        p = _safe(g.order_params(("BTC-USDT-SWAP", 87000.0)), 150 if where == "leverage" else 10)
        routes, state, _, sym, step = flow(p, safe=True)
        spec = R("X", "", resp)["responses"][0]
        path = {"dual": "/fapi/v1/positionSide/dual", "leverage": "/fapi/v1/leverage", "balance": "/fapi/v2/balance",
                "order": "/fapi/v1/order", "close": "/fapi/v1/order", "trail": "/fapi/v1/order"}[where]
        for r in routes:
            if r["path"] == path and r["method"] != "DELETE":
                r["responses"] = [spec] + r["responses"][-1:]
        kw = {"tp2": p["tp2"], "tp3": p["tp3"], "risk_mode": "risk", "order_type": p["order_type"],
              "trade_id": p["trade_id"], "user_id": p["user_id"], "allow_low_notional_boost": True}
        if where in ("dual", "leverage", "balance", "order"):
            S(f"err_{name}", "place_trade", [KEY, SEC, p["symbol"], p["direction"], p["entry"], p["sl"], p["tp1"], p["risk_pct"], p["leverage"]],
              kw, routes, state)
        elif where == "close":
            S(f"err_{name}", "close_position", [KEY, SEC, p["symbol"], p["direction"], float(step) * 3], {}, routes, state)
        else:
            S(f"err_{name}", "set_trailing_sl", [KEY, SEC, p["symbol"], p["sl"], p["direction"]], {}, routes, state)
    return out


# ══ OKX ═════════════════════════════════════════════════════════════════════

def okx_rows(g: Gen):
    KEY, SEC = g.key("OK"), g.key("oks-")
    PP = g.choice(["Pass-phrase#1", "a!b$c%d&e", "Zz9_+=/x", "plain12345"])
    out = []

    def ok_(*data):
        return {"code": "0", "msg": "", "data": list(data)}

    def err(code, msg, data=None):
        return {"code": code, "msg": msg, "data": data if data is not None else []}

    def inst(inst_id, lot, tick, lever, ct):
        d = {"instType": "SWAP", "instId": inst_id, "ctType": "linear", "ctValCcy": inst_id.split("-")[0],
             "lotSz": lot, "tickSz": tick, "lever": lever, "minSz": lot, "state": "live"}
        if ct is not None:
            d["ctVal"] = ct
        return ok_(d)

    def algo():
        return ok_({"algoId": str(g.r.randrange(10**17, 10**18)), "sCode": "0", "sMsg": ""})

    def order():
        return ok_({"ordId": str(g.r.randrange(10**17, 10**18)), "clOrdId": "", "tag": "", "sCode": "0", "sMsg": "Order placed"})

    def S(name, call, args, kwargs, routes, state=None, clock=None):
        out.append({"name": name, "exchange": "okx", "call": call, "args": args, "kwargs": kwargs, "routes": routes,
                    "state": state or {}, "random": [g.r.random() for _ in range(6)], "clock": clock if clock is not None else g.clock()})

    ATTACH_ERR = err("1", "Operation failed.", [{"ordId": "", "clOrdId": "", "sCode": "51000", "sMsg": "Parameter attachAlgoOrds error"}])

    def flow(p, safe=False):
        inst_id = ok.to_okx_symbol(p["symbol"])
        mult = ok.okx_price_multiplier(p["symbol"])
        ct = g.choice(["0.01", "0.1", "1", "10", "100", "1000", "10000", None])
        ctf = float(ct) if ct else 1.0
        lot = g.step_for(_qty_est(p, mult, 5000.0) / ctf) if g.chance(0.7) else g.choice(["1", "0.1", "0.01"])
        bal_v, edge = g.balance_for(p, mult, repr(float(lot) * ctf), p["leverage"])
        tick = g.tick_for(p["entry"] * mult)
        lever = g.choice(["125", "75", "50", "20", "10"])
        if safe:
            ct, lot, tick, bal_v, edge = "0.01", "0.01", "0.1", 5000.0, False
        pos_mode = g.choice(["long", "short", "net"])
        routes = [
            R("GET", "/api/v5/public/instruments", inst(inst_id, lot, tick, lever, ct)),
            R("GET", "/api/v5/account/balance", ok_({"totalEq": _fmt(bal_v), "upl": "0", "details": [{"ccy": "USDT", "eq": _fmt(bal_v), "cashBal": _fmt(bal_v), "availBal": _fmt(bal_v)}]})),
            R("POST", "/api/v5/account/set-leverage", ok_({"instId": inst_id, "lever": "10", "mgnMode": "cross", "posSide": ""})),
            R("POST", "/api/v5/trade/order", *([ATTACH_ERR] if g.chance(0.35) else []), *[order() for _ in range(3)]),
            R("POST", "/api/v5/trade/order-algo", *[algo() for _ in range(6)]),
            R("GET", "/api/v5/account/positions", ok_({"instId": inst_id, "posSide": pos_mode, "pos": g.choice(["1", "-2", "15"]),
                                                        "avgPx": _fmt(p["entry"]), "markPx": _fmt(p["entry"]), "upl": "0", "lever": "10", "liqPx": ""})),
            R("POST", "/api/v5/trade/close-position", ok_({"instId": inst_id, "posSide": pos_mode})),
            R("GET", "/api/v5/trade/orders-pending", ok_(*[{"ordId": str(k), "instId": inst_id, "side": "buy", "ordType": "limit"} for k in range(g.choice([0, 1, 2]))])),
            R("POST", "/api/v5/trade/cancel-order", ok_({"ordId": "1", "sCode": "0", "sMsg": ""})),
            R("GET", "/api/v5/trade/orders-algo-pending", ok_(*[{"algoId": str(k)} for k in range(g.choice([0, 1, 3]))])),
            R("POST", "/api/v5/trade/cancel-algos", ok_()),
            R("GET", "/api/v5/market/ticker", ok_({"instId": inst_id, "last": _fmt(p["entry"])})),
        ]
        state = {}
        if g.chance(0.5):
            state["okx_offset_ms"] = g.r.randint(-3000, 3000)
        return routes, state, edge, inst_id, lot

    n_mgmt = 12
    for i in range(N_ORDER - n_mgmt):
        p = g.order_params()
        routes, state, edge, inst_id, _ = flow(p)
        kw = {"tp2": p["tp2"], "tp3": p["tp3"], "risk_mode": p["risk_mode"], "order_type": p["order_type"],
              "trade_id": p["trade_id"], "user_id": p["user_id"], "allow_low_notional_boost": p["boost"], "passphrase": PP}
        S(f"rnd_pt_{i:02d}_{inst_id}_{p['direction']}_{p['order_type']}_{p['risk_mode']}{'_edge' if edge else ''}", "place_trade",
          [KEY, SEC, p["symbol"], p["direction"], p["entry"], p["sl"], p["tp1"], p["risk_pct"], p["leverage"]], kw, routes, state)
    mg = ["close", "close", "close", "cancel_all", "cancel_all", "trail", "trail", "trail", "breakeven", "breakeven", "sltp", "sltp"]
    for i, kind in enumerate(mg):
        p = g.order_params()
        routes, state, _, inst_id, lot = flow(p)
        if kind == "close":
            side = g.choice(["LONG", "SHORT", "long", "short"])
            S(f"rnd_close_{i:02d}_{inst_id}_{side}", "close_position", [KEY, SEC, p["symbol"], side, PP], {}, routes, state)
        elif kind == "cancel_all":
            S(f"rnd_cancel_all_{i:02d}_{inst_id}", "cancel_all_orders", [KEY, SEC, p["symbol"], PP], {}, routes, state)
        elif kind == "trail":
            S(f"rnd_trail_{i:02d}_{inst_id}_{p['direction']}", "set_trailing_sl", [KEY, SEC, p["symbol"], p["sl"], p["direction"], 0, PP], {}, routes, state)
        elif kind == "breakeven":
            S(f"rnd_be_{i:02d}_{inst_id}_{p['direction']}", "set_breakeven", [KEY, SEC, p["symbol"], p["entry"], p["direction"], 0, PP], {}, routes, state)
        else:
            S(f"rnd_sltp_{i:02d}_{inst_id}_{p['direction']}", "place_sl_tp_for_position",
              [KEY, SEC, p["symbol"], p["direction"], float(lot) * 7, p["sl"], p["tp1"], p["tp2"], p["tp3"], PP], {}, routes, state)

    errs = [
        ("benign_51000_attach_fallback", "order", err("1", "Operation failed.", [{"ordId": "", "sCode": "51000", "sMsg": "Parameter attachAlgoOrds error"}])),
        ("benign_51000_leverage", "leverage", err("51000", "Parameter lever error")),
        ("auth_50113_balance", "balance", err("50113", "Invalid Sign")),
        ("auth_50111_balance", "balance", err("50111", "Invalid OK-ACCESS-KEY")),
        ("rate_50011_order", "order", err("50011", "Rate limit reached. Please refer to API documentation and throttle requests accordingly.")),
        ("http_429_order", "order", {"status": 429, "json": {"msg": "Too Many Requests", "code": "50011"}}),
        ("benign_51000_algo", "algo", err("51000", "Parameter triggerPx error", [{"algoId": "", "sCode": "51000", "sMsg": "Parameter triggerPx error"}])),
        ("close_51023", "close", err("51023", "Position does not exist")),
        ("rate_50011_cancel", "cancel", err("50011", "Rate limit reached.")),
        ("ts_50102_order", "order", err("50102", "Timestamp request expired")),
    ]
    for name, where, resp in errs:
        p = _safe(g.order_params(("BTC-USDT-SWAP", 87000.0)))
        routes, state, _, inst_id, lot = flow(p, safe=True)
        spec = R("X", "", resp)["responses"][0]
        path = {"order": "/api/v5/trade/order", "leverage": "/api/v5/account/set-leverage", "balance": "/api/v5/account/balance",
                "algo": "/api/v5/trade/order-algo", "close": "/api/v5/trade/close-position", "cancel": "/api/v5/trade/cancel-order"}[where]
        for r in routes:
            if r["path"] == path:
                r["responses"] = [spec] + r["responses"][-1:]
        kw = {"tp2": p["tp2"], "tp3": p["tp3"], "risk_mode": "risk", "order_type": p["order_type"],
              "trade_id": p["trade_id"], "user_id": p["user_id"], "allow_low_notional_boost": True, "passphrase": PP}
        if where in ("order", "leverage", "balance"):
            S(f"err_{name}", "place_trade", [KEY, SEC, p["symbol"], p["direction"], p["entry"], p["sl"], p["tp1"], p["risk_pct"], p["leverage"]],
              kw, routes, state)
        elif where == "algo":
            S(f"err_{name}", "set_trailing_sl", [KEY, SEC, p["symbol"], p["sl"], p["direction"], 0, PP], {}, routes, state)
        elif where == "close":
            S(f"err_{name}", "close_position", [KEY, SEC, p["symbol"], p["direction"], PP], {}, routes, state)
        else:
            S(f"err_{name}", "cancel_order", [KEY, SEC, p["symbol"], "123456", PP], {}, routes, state)
    return out


BUILDERS = {"bybit": bybit_rows, "bingx": bingx_rows, "binance": binance_rows, "okx": okx_rows}


def _capture_payloads():
    """harness keeps metric names / [tid, evt] only — record values, tags and event payloads too.

    harness.run_scenario installs its metrics / trade_events stubs and then creates the
    LogCapture; wrapping the stubs at that moment chains onto them."""
    import metrics as metrics_mod
    import db.trade_events as trade_events
    full = {"metrics": [], "events": []}
    orig_lc = harness.LogCapture

    class LC(orig_lc):
        def __init__(self):
            super().__init__()
            m_rec, e_bg = metrics_mod.record, trade_events.emit_bg

            async def _rec(name, value=1.0, tags=None):
                full["metrics"].append([name, value, tags])
                return await m_rec(name, value, tags)

            def _emit(tid, evt, payload=None):
                full["events"].append([tid, evt, payload])
                return e_bg(tid, evt, payload)
            metrics_mod.record = _rec
            trade_events.emit_bg = _emit

    def run(sc):
        full["metrics"].clear()
        full["events"].clear()
        harness.LogCapture = LC
        try:
            res = harness.run_scenario(sc)
        finally:
            harness.LogCapture = orig_lc
        res["full_metrics"] = json.loads(json.dumps(full["metrics"]))
        res["full_events"] = json.loads(json.dumps(full["events"]))
        return res
    return run


def main(which):
    wire.install()
    run = _capture_payloads()
    for ex in which:
        g = Gen(f"{SEED}:{ex}")
        rows = []
        for sc in BUILDERS[ex](g):
            frozen = _freeze_routes(sc)
            res = run(json.loads(json.dumps(frozen)))
            bad = [r for r in res["requests"] if "wire" in r and "error" in r["wire"]]
            if bad:
                raise SystemExit(f"wire capture failed in {sc['name']}: {bad[0]['wire']}")
            rows.append({"scenario": frozen, "expected": res})
            r0 = res.get("result")
            status = "raised" if "raised" in res else ("ok" if isinstance(r0, dict) and r0.get("ok") else ("fail" if isinstance(r0, dict) else "value"))
            print(f"{ex:8s} {sc['name']:60s} {status:6s} reqs={len(res['requests'])}")
        path = os.path.join(HERE, "..", "fixtures", f"adversarial_{ex}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=0)
        print("wrote", path, len(rows))


if __name__ == "__main__":
    main(sys.argv[1:] or ["bybit", "bingx", "binance", "okx"])
