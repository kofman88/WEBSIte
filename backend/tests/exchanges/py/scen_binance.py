"""Binance USDⓈ-M replay scenarios (see harness.py for the format).

Responses follow the shapes of the fapi docs: errors are {"code": <0, "msg": ...}, successes
are raw objects / lists (orders carry "orderId", batchOrders returns a list).
"""

KEY, SEC = "BNKEY-abc123", "bn-secret-456"

INFO = {"timezone": "UTC", "serverTime": 1767225600000, "symbols": [
    {"symbol": "BTCUSDT", "status": "TRADING", "filters": [
        {"filterType": "PRICE_FILTER", "minPrice": "556.80", "maxPrice": "4529764", "tickSize": "0.10"},
        {"filterType": "LOT_SIZE", "stepSize": "0.001", "maxQty": "1000", "minQty": "0.001"},
        {"filterType": "MIN_NOTIONAL", "notional": "100"}]},
    {"symbol": "ETHUSDT", "status": "TRADING", "leverageBracket": [{"initialLeverage": 20}], "filters": [
        {"filterType": "PRICE_FILTER", "tickSize": "0.01"},
        {"filterType": "LOT_SIZE", "stepSize": "0.001"}]},
    {"symbol": "1000PEPEUSDT", "status": "TRADING", "filters": [
        {"filterType": "PRICE_FILTER", "tickSize": "0.0000001"},
        {"filterType": "LOT_SIZE", "stepSize": "1"}]},
    {"symbol": "SOLUSDT", "status": "SETTLING", "filters": []},
    {"symbol": "DOGEUSDT", "status": "TRADING", "filters": [
        {"filterType": "PRICE_FILTER", "tickSize": ""},
        {"filterType": "LOT_SIZE", "stepSize": "1"}]},
]}


def bal(b="1000.50"):
    return [{"accountAlias": "SgsR", "asset": "BNB", "balance": "0.10", "crossWalletBalance": "0.1",
             "crossUnPnl": "0.0", "availableBalance": "0.1", "maxWithdrawAmount": "0.1"},
            {"accountAlias": "SgsR", "asset": "USDT", "balance": b, "crossWalletBalance": b,
             "crossUnPnl": "0.25", "availableBalance": "900.10", "maxWithdrawAmount": "900.10"}]


def err(code, msg):
    return {"code": code, "msg": msg}


DUAL_OK = {"code": 200, "msg": "success"}
DUAL_SAME = err(-4059, "No need to change position side.")
DUAL_EXIST = err(-4061, "Position side cannot be changed if there exists position.")
LEV_OK = {"leverage": 10, "maxNotionalValue": "1000000", "symbol": "BTCUSDT"}
SIG = err(-1022, "Signature for this request is not valid.")


def order(oid=283194212, **kw):
    o = {"orderId": oid, "symbol": "BTCUSDT", "status": "NEW", "clientOrderId": "x", "price": "0",
         "avgPrice": "0.00000", "origQty": "0.011", "executedQty": "0", "type": "MARKET"}
    o.update(kw)
    return o


def price(p, s="BTCUSDT"):
    return {"symbol": s, "price": p, "time": 1767225600000}


def pos(amt="0.011", side="LONG", sym="BTCUSDT", lev="10"):
    return [{"symbol": sym, "positionAmt": amt, "entryPrice": "87000.5", "markPrice": "87010.1",
             "unRealizedProfit": "0.11", "liquidationPrice": "0", "leverage": lev, "positionSide": side},
            {"symbol": sym, "positionAmt": "0.000", "entryPrice": "0.0", "markPrice": "87010.1",
             "unRealizedProfit": "0.0", "leverage": lev, "positionSide": "SHORT" if side == "LONG" else "LONG"}]


def oo(*orders):
    return list(orders)


def o_(oid, typ, side, ps="LONG", stop="86000.0"):
    return {"orderId": oid, "symbol": "BTCUSDT", "type": typ, "side": side, "positionSide": ps,
            "price": "0", "origQty": "0.011", "stopPrice": stop}


def _is_spec(x):
    return isinstance(x, dict) and ("raise" in x or "json" in x or "text" in x or isinstance(x.get("status"), int))


def R(method, path, *resps, query=None):
    r = {"method": method, "path": path, "responses": [x if _is_spec(x) else {"json": x} for x in resps]}
    if query:
        r["query"] = query
    return r


SCENARIOS = []


def S(name, call, args, kwargs=None, routes=None, state=None, random=None, clock=1767225600.0):
    SCENARIOS.append({"name": name, "exchange": "binance", "call": call, "args": args, "kwargs": kwargs or {},
                      "routes": routes or [], "state": state or {}, "random": random or [], "clock": clock})


I = R("GET", "/fapi/v1/exchangeInfo", INFO)
B = R("GET", "/fapi/v2/balance", bal())
D = R("POST", "/fapi/v1/positionSide/dual", DUAL_OK)
L = R("POST", "/fapi/v1/leverage", LEV_OK)
PT = "place_trade"
LONG = [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86000.0, 88500.0, 1.0, 10]
SHORT = [KEY, SEC, "ETH-USDT-SWAP", "SHORT", 3000.0, 3060.0, 2900.0, 2.0, 50]
LADDER = {"tp2": 89500.0, "tp3": 90500.0, "trade_id": "bn-1", "user_id": 42}

BATCH_OK = [order(4001), order(4002, type="STOP_MARKET"), order(4003, type="TAKE_PROFIT_MARKET"),
            order(4004, type="TAKE_PROFIT_MARKET"), order(4005, type="TAKE_PROFIT_MARKET")]

# ── atomic batch ─────────────────────────────────────────────────────────────
S("pt_atomic_ok_ladder", PT, LONG, LADDER, [I, B, D, L, R("POST", "/fapi/v1/batchOrders", BATCH_OK)],
  state={"binance_offset_ms": -350})
S("pt_atomic_ok_tp1_only", PT, LONG, {"trade_id": "bn-2", "user_id": 7},
  [I, B, D, L, R("POST", "/fapi/v1/batchOrders", [order(5001), order(5002), err(-2021, "Order would immediately trigger.")])])
S("pt_atomic_entry_ok_no_tp", PT, LONG, {"tp2": 89500.0, "trade_id": "bn-3", "user_id": 7},
  [I, B, D, L, R("POST", "/fapi/v1/batchOrders", [order(5101), order(5102), err(-2021, "x"), err(-2021, "y")])])
S("pt_atomic_partial_legacy_limit", PT, LONG, LADDER,
  [I, B, D, L, R("POST", "/fapi/v1/batchOrders", [order(4001), err(-2021, "Order would immediately trigger.")]),
   R("GET", "/fapi/v1/ticker/price", price("87010.00")),
   R("POST", "/fapi/v1/order", order(9001, type="LIMIT"), order(9002), order(9003), order(9004), order(9005))])
S("pt_atomic_sig_error_legacy_market", PT, LONG, LADDER,
  [I, B, D, L, R("POST", "/fapi/v1/batchOrders", SIG),
   R("GET", "/fapi/v1/ticker/price", price("88000.00")),
   R("POST", "/fapi/v1/order", order(9101), order(9102), order(9103), order(9104), order(9105))])
S("pt_atomic_dict_nonneg", PT, LONG, LADDER,
  [I, B, D, L, R("POST", "/fapi/v1/batchOrders", {"code": 0, "msg": "weird"}),
   R("GET", "/fapi/v1/ticker/price", price("88000.00")),
   R("POST", "/fapi/v1/order", order(9201), order(9202), order(9203), order(9204), order(9205))])
S("pt_atomic_timeout_fallback", PT, LONG, LADDER,
  [I, B, D, L, R("POST", "/fapi/v1/batchOrders", {"raise": "timeout"}),
   R("GET", "/fapi/v1/ticker/price", {"raise": "connect", "message": "Cannot connect to host fapi.binance.com:443"}),
   R("POST", "/fapi/v1/order", order(9301), order(9302), order(9303), order(9304), order(9305))])
S("pt_atomic_null_response", PT, LONG, LADDER,
  [I, B, D, L, R("POST", "/fapi/v1/batchOrders", {"status": 200, "text": ""}),
   R("GET", "/fapi/v1/ticker/price", price("88000.00")),
   R("POST", "/fapi/v1/order", order(9401), order(9402), order(9403), order(9404), order(9405))])
S("pt_atomic_list_nondict_entries", PT, LONG, LADDER,
  [I, B, D, L, R("POST", "/fapi/v1/batchOrders", [None, "x"]),
   R("GET", "/fapi/v1/ticker/price", price("88000.00")),
   R("POST", "/fapi/v1/order", order(9501), order(9502), order(9503), order(9504), order(9505))])

# ── legacy-only paths (no trade_id) ──────────────────────────────────────────
S("pt_no_tid_market_single_tp", PT, LONG, {},
  [I, B, D, L, R("GET", "/fapi/v1/ticker/price", price("87500.00")),
   R("POST", "/fapi/v1/order", order(1), order(2), order(3))])
S("pt_no_tid_limit_ladder_two_tps", PT, LONG, {"tp2": 89500.0},
  [I, B, D, L, R("GET", "/fapi/v1/ticker/price", price("86990.0")),
   R("POST", "/fapi/v1/order", order(1), order(2), order(3), order(4))])
S("pt_short_oneway_4061", PT, SHORT, {"tp2": 2850.0, "tp3": 2800.0},
  [I, B, R("POST", "/fapi/v1/positionSide/dual", DUAL_EXIST), L,
   R("GET", "/fapi/v1/ticker/price", price("3001.0", "ETHUSDT")),
   R("POST", "/fapi/v1/order", order(11), order(12), order(13), order(14), order(15))])
S("pt_dual_4059_keeps_hedge", PT, SHORT, {},
  [I, B, R("POST", "/fapi/v1/positionSide/dual", DUAL_SAME), L,
   R("GET", "/fapi/v1/ticker/price", price("3100.0", "ETHUSDT")),
   R("POST", "/fapi/v1/order", order(11), order(12), order(13))])
S("pt_dual_4061_other_msg", PT, SHORT, {},
  [I, B, R("POST", "/fapi/v1/positionSide/dual", err(-4061, "Order's position side does not match user's setting.")), L,
   R("GET", "/fapi/v1/ticker/price", price("3100.0", "ETHUSDT")),
   R("POST", "/fapi/v1/order", order(11), order(12), order(13))])
S("pt_leverage_halving", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86000.0, 88500.0, 1.0, 100], {},
  [I, B, D, R("POST", "/fapi/v1/leverage", err(-4028, "Leverage 100 is not valid"), err(-4060, "Invalid position side."), LEV_OK),
   R("GET", "/fapi/v1/ticker/price", price("87500.00")),
   R("POST", "/fapi/v1/order", order(1), order(2), order(3))])
S("pt_leverage_halving_exhausted_margin", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86000.0, 88500.0, 1.0, 100],
  {"risk_mode": "margin"},
  [I, B, D, R("POST", "/fapi/v1/leverage", err(-4028, "Leverage 100 is not valid")),
   R("GET", "/fapi/v1/ticker/price", price("87500.00")),
   R("POST", "/fapi/v1/order", order(1), order(2), order(3))])
S("pt_leverage_other_error", PT, LONG, {},
  [I, B, D, R("POST", "/fapi/v1/leverage", err(-1102, "Mandatory parameter 'leverage' was not sent.")),
   R("GET", "/fapi/v1/ticker/price", price("87500.00")),
   R("POST", "/fapi/v1/order", order(1), order(2), order(3))])
S("pt_leverage_lev1_4028", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86000.0, 88500.0, 1.0, 1], {},
  [I, B, D, R("POST", "/fapi/v1/leverage", err(-4028, "Leverage 1 is not valid")),
   R("GET", "/fapi/v1/ticker/price", price("87500.00")),
   R("POST", "/fapi/v1/order", order(1), order(2), order(3))])
S("pt_symbol_bracket_max_lev_notional", PT, SHORT, {"risk_mode": "notional"},
  [I, B, D, L, R("GET", "/fapi/v1/ticker/price", price("3100.0", "ETHUSDT")),
   R("POST", "/fapi/v1/order", order(1), order(2), order(3))])
S("pt_symbol_not_trading", PT, [KEY, SEC, "SOL-USDT-SWAP", "LONG", 150.0, 145.0, 160.0, 1.0, 10], {}, [I])
S("pt_exchange_info_down", PT, LONG, {}, [R("GET", "/fapi/v1/exchangeInfo", {"status": 503, "text": "<html>503</html>", "headers": {"Content-Type": "text/html"}})])
S("pt_zero_balance", PT, LONG, {}, [I, R("GET", "/fapi/v2/balance", err(-2015, "Invalid API-key, IP, or permissions for action."))])
S("pt_balance_no_usdt", PT, LONG, {}, [I, R("GET", "/fapi/v2/balance", [{"asset": "BNB", "balance": "1"}])])
S("pt_encrypted_key", PT, ["gAAAAAbcdef", SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86000.0, 88500.0, 1.0, 10], {}, [I])
S("pt_balance_timeout", PT, LONG, {}, [I, R("GET", "/fapi/v2/balance", {"raise": "timeout"})])
S("pt_sl_equals_entry", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 87000.5, 88500.0, 1.0, 10], {}, [I, B, D, L])
S("pt_low_notional_skip", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86000.0, 88500.0, 0.05, 10], {},
  [I, R("GET", "/fapi/v2/balance", bal("100.0")), D, L])
S("pt_low_notional_boost", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86000.0, 88500.0, 0.05, 10],
  {"allow_low_notional_boost": True},
  [I, R("GET", "/fapi/v2/balance", bal("100.0")), D, L, R("GET", "/fapi/v1/ticker/price", price("87500.00")),
   R("POST", "/fapi/v1/order", order(1), order(2), order(3))])
S("pt_low_notional_boost_too_small", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 870000.5, 860000.0, 885000.0, 0.01, 10],
  {"allow_low_notional_boost": True}, [I, R("GET", "/fapi/v2/balance", bal("100.0")), D, L])
S("pt_qty_zero_bumped_to_step", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86000.0, 88500.0, 0.001, 10],
  {"allow_low_notional_boost": True},
  [I, B, D, L, R("GET", "/fapi/v1/ticker/price", price("87500.00")),
   R("POST", "/fapi/v1/order", order(1), order(2), order(3))])
S("pt_entry_duplicate_4015", PT, LONG, LADDER,
  [I, B, D, L, R("POST", "/fapi/v1/batchOrders", SIG), R("GET", "/fapi/v1/ticker/price", price("88000.00")),
   R("POST", "/fapi/v1/order", err(-4015, "Client order id is not valid."))])
S("pt_entry_duplicate_msg", PT, LONG, LADDER,
  [I, B, D, L, R("POST", "/fapi/v1/batchOrders", SIG), R("GET", "/fapi/v1/ticker/price", price("88000.00")),
   R("POST", "/fapi/v1/order", err(-1102, "Client order id already exists"))])
S("pt_entry_error_insufficient", PT, LONG, {},
  [I, B, D, L, R("GET", "/fapi/v1/ticker/price", price("88000.00")),
   R("POST", "/fapi/v1/order", err(-2019, "Margin is insufficient."))])
S("pt_entry_html_502", PT, LONG, {},
  [I, B, D, L, R("GET", "/fapi/v1/ticker/price", price("88000.00")),
   R("POST", "/fapi/v1/order", {"status": 502, "text": "<html><body>502 Bad Gateway</body></html>", "headers": {"Content-Type": "text/html"}})])
S("pt_sl_duplicate", PT, LONG, LADDER,
  [I, B, D, L, R("POST", "/fapi/v1/batchOrders", SIG), R("GET", "/fapi/v1/ticker/price", price("88000.00")),
   R("POST", "/fapi/v1/order", order(1), err(-4015, "Client order id is not valid."), order(3), order(4), order(5))])
S("pt_sl_fail_safety_close_ok", PT, LONG, {},
  [I, B, D, L, R("GET", "/fapi/v1/ticker/price", price("88000.00")),
   R("POST", "/fapi/v1/order", order(1), err(-2021, "Order would immediately trigger."), {"json": {}},
     err(-1001, "Internal error; unable to process your request. Please try again."), order(77)),
   R("DELETE", "/fapi/v1/allOpenOrders", {"code": 200, "msg": "The operation of cancel all open order is done."}),
   R("GET", "/fapi/v2/positionRisk", pos())])
S("pt_sl_fail_safety_close_fail", PT, LONG, {},
  [I, B, D, L, R("GET", "/fapi/v1/ticker/price", price("88000.00")),
   R("POST", "/fapi/v1/order", order(1), err(-2021, "a"), err(-2021, "b"), err(-2021, "c"), err(-2022, "ReduceOnly Order is rejected.")),
   R("DELETE", "/fapi/v1/allOpenOrders", {"code": 200, "msg": "done"}),
   R("GET", "/fapi/v2/positionRisk", pos())])
S("pt_sl_fail_cancel_retry_no_position", PT, LONG, {},
  [I, B, D, L, R("GET", "/fapi/v1/ticker/price", price("88000.00")),
   R("POST", "/fapi/v1/order", order(1), err(-2021, "a")),
   R("DELETE", "/fapi/v1/allOpenOrders", {"raise": "timeout"}, {"code": 200, "msg": "done"}),
   R("GET", "/fapi/v2/positionRisk", [])], random=[0.0, 1.0])
S("pt_tp_2021_adaptive", PT, LONG, {"tp2": 89500.0},
  [I, B, D, L, R("GET", "/fapi/v1/ticker/price", price("88000.00"), price("89600.00")),
   R("POST", "/fapi/v1/order", order(1), order(2), err(-2021, "Order would immediately trigger."), order(3), order(4))])
S("pt_tp_2021_short_no_ticker", PT, SHORT, {},
  [I, B, D, L, R("GET", "/fapi/v1/ticker/price", price("3100.0", "ETHUSDT"), {"status": 404, "text": "nf", "headers": {"Content-Type": "text/plain"}}),
   R("POST", "/fapi/v1/order", order(1), order(2), err(-2021, "x"), err(-2021, "x"), err(-2021, "x"), err(-2021, "x"), err(-2021, "x"))])
S("pt_tp_all_fail_partial", PT, LONG, {"tp2": 89500.0, "tp3": 90500.0},
  [I, B, D, L, R("GET", "/fapi/v1/ticker/price", price("88000.00")),
   R("POST", "/fapi/v1/order", order(1), order(2), order(3), order(4),
     err(-1001, "Internal error"), err(-1001, "Internal error"), err(-1001, "Internal error"), err(-1001, "Internal error"), err(-1001, "Internal error"))])
S("pt_tp_duplicate", PT, LONG, LADDER,
  [I, B, D, L, R("POST", "/fapi/v1/batchOrders", SIG), R("GET", "/fapi/v1/ticker/price", price("88000.00")),
   R("POST", "/fapi/v1/order", order(1), order(2), err(-4015, "dup"), err(-1102, "Client order id already used"), order(5))])
S("pt_pepe_1000x", PT, [KEY, SEC, "PEPE-USDT-SWAP", "LONG", 0.0000123, 0.0000118, 0.0000131, 1.0, 10],
  {"tp2": 0.0000139, "tp3": 0.0000147},
  [I, B, D, L, R("GET", "/fapi/v1/ticker/price", price("0.0123100", "1000PEPEUSDT")),
   R("POST", "/fapi/v1/order", order(1), order(2), order(3), order(4), order(5))])
S("pt_doge_empty_tick", PT, [KEY, SEC, "DOGE-USDT-SWAP", "SHORT", 0.18234, 0.18851, 0.17111, 1.0, 10], {},
  [I, B, D, L, R("GET", "/fapi/v1/ticker/price", price("0.18000", "DOGEUSDT")),
   R("POST", "/fapi/v1/order", order(1), order(2), order(3))])
S("pt_killswitch", PT, LONG, {}, [], state={"ks_halted": "HALTED"})
S("pt_plan_deny", PT, LONG, {"user_id": 5}, [], state={"plan_deny": {"ok": False, "order_id": "", "error": "plan_denied", "plan_denied": True}})

# ── reads ────────────────────────────────────────────────────────────────────
S("get_balance_ok", "get_balance", [KEY, SEC], {}, [B])
S("get_balance_error", "get_balance", [KEY, SEC], {}, [R("GET", "/fapi/v2/balance", err(-2015, "Invalid API-key"))])
S("get_balance_no_usdt", "get_balance", [KEY, SEC], {}, [R("GET", "/fapi/v2/balance", [{"asset": "BNB", "balance": "1"}])])
S("get_last_price_ok", "get_last_price", [KEY, SEC, "FLOKI-USDT-SWAP"], {}, [R("GET", "/fapi/v1/ticker/price", price("0.14", "1000FLOKIUSDT"))])
S("get_last_price_err", "get_last_price", [KEY, SEC, "BTC-USDT-SWAP"], {}, [R("GET", "/fapi/v1/ticker/price", err(-1121, "Invalid symbol."))])
S("test_connection_ok", "test_connection", [KEY, SEC], {}, [B])
S("test_connection_bad_key", "test_connection", [KEY, SEC], {}, [R("GET", "/fapi/v2/balance", err(-2014, "API-key format invalid."))])
S("test_connection_other", "test_connection", [KEY, SEC], {}, [R("GET", "/fapi/v2/balance", {"code": 0, "msg": ""})])
S("test_connection_timeout", "test_connection", [KEY, SEC], {}, [R("GET", "/fapi/v2/balance", {"raise": "timeout"})])
S("get_positions_symbol", "get_positions", [KEY, SEC, "BTC-USDT-SWAP"], {}, [R("GET", "/fapi/v2/positionRisk", pos())])
S("get_positions_all_oneway", "get_positions", [KEY, SEC], {},
  [R("GET", "/fapi/v2/positionRisk", [{"symbol": "ETHUSDT", "positionAmt": "-1.5", "entryPrice": "3000", "markPrice": "2990",
                                       "unRealizedProfit": "15", "leverage": "20", "positionSide": "BOTH"},
                                      {"symbol": "BTCUSDT", "positionAmt": "0.002", "entryPrice": "", "markPrice": None,
                                       "unRealizedProfit": "0", "leverage": "", "positionSide": "BOTH"}])])
S("get_positions_error", "get_positions", [KEY, SEC], {}, [R("GET", "/fapi/v2/positionRisk", err(-1021, "Timestamp for this request is outside of the recvWindow."))])
S("get_open_orders_ok", "get_open_orders", [KEY, SEC], {}, [R("GET", "/fapi/v1/openOrders", oo(o_(1, "STOP_MARKET", "SELL")))])
S("get_open_orders_err", "get_open_orders", [KEY, SEC], {}, [R("GET", "/fapi/v1/openOrders", err(-1003, "Too many requests"))])
S("get_closed_pnl", "get_closed_pnl", [KEY, SEC, "BTC-USDT-SWAP"], {},
  [R("GET", "/fapi/v1/userTrades", [
      {"symbol": "BTCUSDT", "id": 1, "orderId": 8389765519, "side": "BUY", "price": "87000.5", "qty": "0.011", "realizedPnl": "0", "time": 1767220000000},
      {"symbol": "BTCUSDT", "id": 2, "orderId": 8389765520, "side": "SELL", "price": "87500.0", "qty": "0.011", "realizedPnl": "5.49450000", "time": 1767225000000},
      {"symbol": "BTCUSDT", "id": 3, "orderId": None, "side": "sell", "price": "87400.0", "qty": "0.001", "realizedPnl": "", "time": None},
      {"symbol": "BTCUSDT", "id": 4, "orderId": 5, "side": "SELL", "price": "0", "qty": "0.001", "realizedPnl": "1"},
      {"symbol": "BTCUSDT", "id": 5, "orderId": 6, "side": "SELL", "price": "87400.0", "qty": "0.001", "realizedPnl": "n/a", "time": 1}])])
S("get_closed_pnl_err", "get_closed_pnl", [KEY, SEC, "BTC-USDT-SWAP"], {}, [R("GET", "/fapi/v1/userTrades", err(-1121, "Invalid symbol."))])
S("get_dashboard", "get_dashboard", [KEY, SEC], {},
  [R("GET", "/fapi/v2/positionRisk", pos()),
   R("GET", "/fapi/v1/openOrders", oo(o_(1, "STOP_MARKET", "SELL"), o_(2, "TAKE_PROFIT_MARKET", "SELL", stop="88500"))),
   B, R("GET", "/fapi/v1/income", [{"income": "5.5"}, {"income": "-2.25"}, {"income": "0.1"}, {"income": ""}])])
S("get_dashboard_errors", "get_dashboard", [KEY, SEC], {},
  [R("GET", "/fapi/v2/positionRisk", err(-1, "x")), R("GET", "/fapi/v1/openOrders", err(-1, "x")),
   R("GET", "/fapi/v2/balance", [{"asset": "BNB"}]), R("GET", "/fapi/v1/income", err(-1, "x"))])
S("get_dashboard_crash", "get_dashboard", [KEY, SEC], {},
  [R("GET", "/fapi/v2/positionRisk", []), R("GET", "/fapi/v1/openOrders", ["oops"])])

# ── order management ─────────────────────────────────────────────────────────
S("close_position_ok", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.0115], {}, [I, R("POST", "/fapi/v1/order", order(55))])
S("close_position_short_error", "close_position", [KEY, SEC, "ETH-USDT-SWAP", "short", 1.5], {},
  [I, R("POST", "/fapi/v1/order", err(-2022, "ReduceOnly Order is rejected."))])
S("close_position_zero_qty", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.0004], {}, [I])
S("close_position_no_order_id", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.011], {}, [I, R("POST", "/fapi/v1/order", {"status": "NEW"})])
S("cancel_order_ok", "cancel_order", [KEY, SEC, "BTC-USDT-SWAP", "283194212"], {}, [R("DELETE", "/fapi/v1/order", order(283194212, status="CANCELED"))])
S("cancel_order_err", "cancel_order", [KEY, SEC, "BTC-USDT-SWAP", 12], {}, [R("DELETE", "/fapi/v1/order", err(-2011, "Unknown order sent."))])
S("cancel_all_ok", "cancel_all_orders", [KEY, SEC, "BTC-USDT-SWAP"], {}, [R("DELETE", "/fapi/v1/allOpenOrders", {"code": 200, "msg": "done"})])
S("cancel_all_err", "cancel_all_orders", [KEY, SEC, "BTC-USDT-SWAP"], {}, [R("DELETE", "/fapi/v1/allOpenOrders", err(-2015, "Invalid API-key"))])
S("cancel_all_timeout_retries", "cancel_all_orders", [KEY, SEC, "BTC-USDT-SWAP"], {}, [R("DELETE", "/fapi/v1/allOpenOrders", {"raise": "timeout"})], random=[0.1, 0.9])
S("cancel_tp_only", "cancel_tp_orders_only", [KEY, SEC, "BTC-USDT-SWAP"], {},
  [R("GET", "/fapi/v1/openOrders", oo(o_(1, "STOP_MARKET", "SELL"), o_(2, "TAKE_PROFIT_MARKET", "SELL"), o_(3, "take_profit_market", "SELL"), o_(None, "TAKE_PROFIT_MARKET", "SELL"))),
   R("DELETE", "/fapi/v1/order", order(2), err(-2011, "Unknown order sent."))])
S("cancel_tp_only_dict", "cancel_tp_orders_only", [KEY, SEC, "BTC-USDT-SWAP"], {}, [R("GET", "/fapi/v1/openOrders", err(-2015, "Invalid"))])
S("trail_ok", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 86500.07, "LONG"], {},
  [I, R("GET", "/fapi/v1/openOrders", oo(o_(1, "STOP_MARKET", "SELL"), o_(2, "TAKE_PROFIT_MARKET", "SELL"), o_(3, "STOP_MARKET", "BUY"))),
   R("DELETE", "/fapi/v1/order", order(1)), R("GET", "/fapi/v2/positionRisk", pos()), R("POST", "/fapi/v1/order", order(99))])
S("trail_retry_then_ok", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 86500.0, "LONG"], {},
  [I, R("GET", "/fapi/v1/openOrders", []), R("GET", "/fapi/v2/positionRisk", pos()),
   R("POST", "/fapi/v1/order", {"raise": "timeout"}, err(-1001, "Internal error; unable to process your request. Please try again."), order(99))],
  random=[0.25, 0.75])
S("trail_error", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 86500.0, "LONG"], {},
  [I, R("GET", "/fapi/v1/openOrders", []), R("GET", "/fapi/v2/positionRisk", pos()),
   R("POST", "/fapi/v1/order", err(-2021, "Order would immediately trigger."))])
S("trail_no_position", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 86500.0, "SHORT"], {},
  [I, R("GET", "/fapi/v1/openOrders", err(-1, "x")), R("GET", "/fapi/v2/positionRisk", pos())])
S("trail_qty_zero", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 86500.0, "LONG"], {},
  [I, R("GET", "/fapi/v1/openOrders", []), R("GET", "/fapi/v2/positionRisk", pos("0.0004"))])
S("breakeven_ok_pepe", "set_breakeven", [KEY, SEC, "PEPE-USDT-SWAP", 0.0000123, "SHORT"], {},
  [I, R("GET", "/fapi/v1/openOrders", oo(o_(7, "STOP_MARKET", "BUY", "SHORT"))), R("DELETE", "/fapi/v1/order", {}),
   R("GET", "/fapi/v2/positionRisk", pos("-12000", "SHORT", "1000PEPEUSDT")), R("POST", "/fapi/v1/order", order(9))])
S("breakeven_error", "set_breakeven", [KEY, SEC, "BTC-USDT-SWAP", 87000.5, "LONG"], {},
  [I, R("GET", "/fapi/v1/openOrders", []), R("GET", "/fapi/v2/positionRisk", pos()), R("POST", "/fapi/v1/order", err(-4131, "x"))])
S("breakeven_qty_zero", "set_breakeven", [KEY, SEC, "BTC-USDT-SWAP", 87000.5, "LONG"], {},
  [I, R("GET", "/fapi/v1/openOrders", []), R("GET", "/fapi/v2/positionRisk", pos("0.0001"))])
S("sltp_for_position_full", "place_sl_tp_for_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.011, 86000.0, 88500.0, 89500.0, 90500.0], {},
  [I, R("POST", "/fapi/v1/order", order(501), order(502), order(503), order(504)),
   R("GET", "/fapi/v1/openOrders",
     oo(o_(501, "STOP_MARKET", "SELL"), o_(400, "STOP_MARKET", "SELL"), o_(401, "TAKE_PROFIT_MARKET", "SELL"), o_(402, "LIMIT", "SELL"), o_(403, "STOP_MARKET", "BUY")),
     oo(o_(502, "TAKE_PROFIT_MARKET", "SELL"), o_(503, "TAKE_PROFIT_MARKET", "SELL"), o_(504, "TAKE_PROFIT_MARKET", "SELL"))),
   R("DELETE", "/fapi/v1/order", order(400))])
S("sltp_for_position_phantom", "place_sl_tp_for_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.011, 86000.0, 88500.0], {},
  [I, R("POST", "/fapi/v1/order", order(501), order(502)),
   R("GET", "/fapi/v1/openOrders", [], oo(o_(502, "TAKE_PROFIT_MARKET", "SELL", "SHORT")))])
S("sltp_for_position_sl_4131_tp_2021", "place_sl_tp_for_position", [KEY, SEC, "ETH-USDT-SWAP", "SHORT", 1.5, 3060.0, 2900.0, 2850.0], {},
  [I, R("POST", "/fapi/v1/order", err(-4131, "The counterparty's best price does not meet the PERCENT_PRICE filter limit."),
        err(-2021, "Order would immediately trigger."), err(-2021, "again"), err(-2021, "third"), order(7), err(-1001, "x"), err(-1001, "x"), err(-1001, "x")),
   R("GET", "/fapi/v1/openOrders", err(-1, "x"), oo(o_(7, "TAKE_PROFIT_MARKET", "BUY", "SHORT")))])
S("sltp_for_position_no_sl", "place_sl_tp_for_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.011, 0.0, 88500.0], {},
  [I, R("POST", "/fapi/v1/order", order(1)), R("GET", "/fapi/v1/openOrders", "not-a-list", oo(o_(1, "TAKE_PROFIT_MARKET", "SELL")))])

# ── time sync / endpoint probe ───────────────────────────────────────────────
S("sync_time_ok", "sync_time", [], {}, [R("GET", "/fapi/v1/time", {"serverTime": 1767225601234})], clock=1767225600.5)
S("sync_time_fail", "sync_time", [], {}, [R("GET", "/fapi/v1/time", {"status": 451, "text": "geo", "headers": {"Content-Type": "text/plain"}})])
S("sync_time_missing_key", "sync_time", [], {}, [R("GET", "/fapi/v1/time", {"code": -1})])
S("find_url_first_ok", "_find_working_binance_url", [], {}, [R("GET", "/fapi/v1/ping", {})])
S("find_url_dns_retry_then_next", "_find_working_binance_url", [], {},
  [R("GET", "/fapi/v1/ping", {"raise": "connect", "message": "Cannot connect to host fapi.binance.com:443 ssl:default [Name or service not known]"},
     {"raise": "connect", "message": "dns"}, {"raise": "connect", "message": "dns again"}, {"raise": "timeout"},
     {"status": 418, "text": "teapot"}, {"raise": "error", "message": "weird"}, {})])
S("find_url_all_fail", "_find_working_binance_url", [], {}, [R("GET", "/fapi/v1/ping", {"status": 403, "text": "geo"})])
