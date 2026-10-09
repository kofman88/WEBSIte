"""BingX replay scenarios (see harness.py for the format)."""

KEY, SEC = "BXKEY-abc123", "bx-secret-456"
OID = 1735947220470939648  # int64 order id (> 2^53) like the real API

CONTRACTS = {"code": 0, "msg": "", "data": [
    {"symbol": "BTC-USDT", "tradeMinQuantity": 0.0001, "pricePrecision": 1, "maxLeverage": 125, "status": 1},
    {"symbol": "ETH-USDT", "tradeMinQuantity": 0.01, "pricePrecision": 2, "maxLeverage": 100, "status": 1},
    {"symbol": "1000PEPE-USDT", "tradeMinQuantity": 100, "pricePrecision": 7, "maxLeverage": 50, "status": 1},
    {"symbol": "TONCOIN-USDT", "tradeMinQuantity": 1, "pricePrecision": 4, "maxLeverage": "75", "status": 1},
    {"symbol": "ASTER-USDT", "tradeMinQuantity": 2.64, "pricePrecision": 4, "maxLeverage": 20, "status": 1},
]}


def bal(eq="1000.5"):
    return {"code": 0, "msg": "", "data": {"balance": {"userId": "1", "asset": "USDT", "balance": "1000.0", "equity": eq,
                                                       "unrealizedProfit": "0.5", "availableMargin": "900.0"}}}


LEV_OK = {"code": 0, "msg": "", "data": {"leverage": 10, "symbol": "BTC-USDT"}}
BATCH_SIG = {"code": 100001, "msg": "Signature verification failed", "data": {}}


def price(p):
    return {"code": 0, "msg": "", "data": {"symbol": "BTC-USDT", "price": p, "time": 1767225600000}}


def order(oid=OID):
    return {"code": 0, "msg": "", "data": {"order": {"orderId": oid, "symbol": "BTC-USDT", "side": "BUY", "type": "LIMIT"}}}


def pos(sym="BTC-USDT", amt="0.0115", side="LONG", lev=10, avg="87000.5"):
    return {"code": 0, "msg": "", "data": [{"symbol": sym, "positionSide": side, "positionAmt": amt, "avgPrice": avg,
                                            "markPrice": avg, "unrealizedProfit": "0.12", "leverage": lev, "stopLoss": ""}]}


NOPOS = {"code": 0, "msg": "", "data": []}


def oo(*orders):
    return {"code": 0, "msg": "", "data": {"orders": list(orders)}}


def err(code, msg):
    return {"code": code, "msg": msg, "data": {}}


def R(method, path, *resps, query=None):
    r = {"method": method, "path": path, "responses": [x if ("raise" in x or "status" in x or "json" in x or "text" in x) else {"json": x} for x in resps]}
    if query:
        r["query"] = query
    return r


SCENARIOS = []


def S(name, call, args, kwargs=None, routes=None, state=None, random=None, clock=1767225600.0):
    SCENARIOS.append({"name": name, "exchange": "bingx", "call": call, "args": args, "kwargs": kwargs or {},
                      "routes": routes or [], "state": state or {}, "random": random or [], "clock": clock})


C = R("GET", "/openApi/swap/v2/quote/contracts", CONTRACTS)
B = R("GET", "/openApi/swap/v2/user/balance", bal())
L = R("POST", "/openApi/swap/v2/trade/leverage", LEV_OK)
PT = "place_trade"
LONG = [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86000.0, 88500.0, 1.0, 10]

S("pt_long_limit_legacy_full", PT, LONG, {"tp2": 89500.0, "tp3": 90500.0, "trade_id": "bx-1", "user_id": 42},
  [C, B, L, R("POST", "/openApi/swap/v2/trade/batchOrders", BATCH_SIG),
   R("GET", "/openApi/swap/v2/quote/price", price("87010.0")),
   R("POST", "/openApi/swap/v2/trade/order", order(), order(11), order(12), order(13), order(14)),
   R("GET", "/openApi/swap/v2/user/positions", NOPOS, pos()),
   R("GET", "/openApi/swap/v2/trade/openOrders", oo({"orderId": 12, "type": "TAKE_PROFIT_MARKET", "side": "SELL"},
                                                   {"orderId": 13, "type": "TAKE_PROFIT_MARKET", "side": "SELL"},
                                                   {"orderId": 14, "type": "TAKE_PROFIT_MARKET", "side": "SELL"}))])
S("pt_short_market_oneway_109400", PT, [KEY, SEC, "ETH-USDT-SWAP", "SHORT", 3000.0, 3060.0, 2900.0, 2.0, 20], {},
  [C, B, R("POST", "/openApi/swap/v2/trade/leverage", err(109400, "In One-way mode, side should be BOTH"), LEV_OK),
   R("GET", "/openApi/swap/v2/quote/price", price("3050.0")),
   R("POST", "/openApi/swap/v2/trade/order", err(109400, "positionSide error"), order(21), order(22), order(23), order(24)),
   R("GET", "/openApi/swap/v2/user/positions", pos("ETH-USDT", "-6.66", "BOTH")),
   R("GET", "/openApi/swap/v2/trade/openOrders", oo())])
S("pt_atomic_batch_ok", PT, LONG, {"tp2": 89500.0, "trade_id": "bx-2", "user_id": 1},
  [C, B, L, R("POST", "/openApi/swap/v2/trade/batchOrders",
              {"code": 0, "msg": "", "data": {"orders": [{"orderId": OID}, {"orderId": 2}, {"orderId": 3}, {"code": 101, "msg": "x"}]}})])
S("pt_atomic_batch_partial", PT, LONG, {"trade_id": "bx-3", "user_id": 1},
  [C, B, L, R("POST", "/openApi/swap/v2/trade/batchOrders", {"code": 0, "msg": "", "data": [{"orderId": 5}, {"code": 0}]}),
   R("GET", "/openApi/swap/v2/quote/price", price("90000")),
   R("POST", "/openApi/swap/v2/trade/order", order(31), order(32), order(33)),
   R("GET", "/openApi/swap/v2/user/positions", pos()),
   R("GET", "/openApi/swap/v2/trade/openOrders", oo({"orderId": 33, "type": "TAKE_PROFIT_MARKET", "side": "SELL"}))])
S("pt_limit_unfilled_cancel", PT, LONG, {},
  [C, B, L, R("GET", "/openApi/swap/v2/quote/price", price("87000.0")),
   R("POST", "/openApi/swap/v2/trade/order", order()),
   R("GET", "/openApi/swap/v2/user/positions", NOPOS),
   R("DELETE", "/openApi/swap/v2/trade/allOpenOrders", {"code": 0, "msg": "", "data": {"success": [], "orders": [{"orderId": OID}]}})])
S("pt_sl_fail_safety_close", PT, LONG, {"trade_id": "bx-4", "user_id": 2},
  [C, B, L, R("POST", "/openApi/swap/v2/trade/batchOrders", BATCH_SIG),
   R("GET", "/openApi/swap/v2/quote/price", price("80000")),
   R("POST", "/openApi/swap/v2/trade/order", order(), err(101400, "invalid stopPrice trigger"), err(101400, "stopPrice invalid"),
     err(80012, "service unavailable"), err(80012, "x"), err(80012, "y"), order(99)),
   R("GET", "/openApi/swap/v2/user/positions", pos()),
   R("DELETE", "/openApi/swap/v2/trade/allOpenOrders", {"code": 0, "msg": "", "data": {"orders": []}})])
S("pt_tp_110413_adaptive", PT, LONG, {"tp2": 89500.0},
  [C, B, L, R("GET", "/openApi/swap/v2/quote/price", price("87300"), price("88900.5")),
   R("POST", "/openApi/swap/v2/trade/order", order(), order(2), err(110413, "TP price must be greater than current"), order(4)),
   R("GET", "/openApi/swap/v2/user/positions", pos()),
   R("GET", "/openApi/swap/v2/trade/openOrders", oo({"type": "TAKE_PROFIT_MARKET", "side": "SELL"}, {"type": "TAKE_PROFIT_MARKET", "side": "SELL"}))])
S("pt_duplicate_entry", PT, LONG, {"trade_id": "bx-5", "user_id": 3},
  [C, B, L, R("POST", "/openApi/swap/v2/trade/batchOrders", BATCH_SIG), R("GET", "/openApi/swap/v2/quote/price", price("87000")),
   R("POST", "/openApi/swap/v2/trade/order", err(101404, "duplicate clientOrderID"))])
# [BINGX-DUP-VERIFY 2026-10] 101204 = insufficient margin: a duplicate only when the order with the cid is found
S("pt_101204_cid_not_found", PT, LONG, {"trade_id": "bx-6", "user_id": 3},
  [C, B, L, R("POST", "/openApi/swap/v2/trade/batchOrders", BATCH_SIG), R("GET", "/openApi/swap/v2/quote/price", price("87000")),
   R("POST", "/openApi/swap/v2/trade/order", err(101204, "Insufficient margin")),
   R("GET", "/openApi/swap/v2/trade/order", err(109414, "order not exist"))])
S("pt_101204_cid_found", PT, LONG, {"trade_id": "bx-7", "user_id": 3},
  [C, B, L, R("POST", "/openApi/swap/v2/trade/batchOrders", BATCH_SIG), R("GET", "/openApi/swap/v2/quote/price", price("87000")),
   R("POST", "/openApi/swap/v2/trade/order", err(101204, "Insufficient margin")),
   R("GET", "/openApi/swap/v2/trade/order", {"code": 0, "msg": "", "data": {"order": {"orderId": 1700000000000000001, "status": "FILLED"}}})])
S("pt_101204_cid_lookup_fails", PT, LONG, {"trade_id": "bx-8", "user_id": 3},
  [C, B, L, R("POST", "/openApi/swap/v2/trade/batchOrders", BATCH_SIG), R("GET", "/openApi/swap/v2/quote/price", price("87000")),
   R("POST", "/openApi/swap/v2/trade/order", err(101204, "Insufficient margin")),
   R("GET", "/openApi/swap/v2/trade/order", {"raise": "timeout"})])
S("pt_101404_cid_empty_order", PT, LONG, {"trade_id": "bx-9", "user_id": 3},
  [C, B, L, R("POST", "/openApi/swap/v2/trade/batchOrders", BATCH_SIG), R("GET", "/openApi/swap/v2/quote/price", price("87000")),
   R("POST", "/openApi/swap/v2/trade/order", err(101404, "order rejected")),
   R("GET", "/openApi/swap/v2/trade/order", {"code": 0, "msg": "", "data": {"order": None}})])
S("pt_clientorder_exists_text", PT, LONG, {"trade_id": "bx-10", "user_id": 3},
  [C, B, L, R("POST", "/openApi/swap/v2/trade/batchOrders", BATCH_SIG), R("GET", "/openApi/swap/v2/quote/price", price("87000")),
   R("POST", "/openApi/swap/v2/trade/order", err(80001, "ClientOrderID already EXISTS"))])
S("pt_sl_101204_verified", PT, LONG, {"trade_id": "bx-11", "user_id": 3},
  [C, B, L, R("POST", "/openApi/swap/v2/trade/batchOrders", BATCH_SIG), R("GET", "/openApi/swap/v2/quote/price", price("87000")),
   R("POST", "/openApi/swap/v2/trade/order", order(), err(101204, "Insufficient margin"), order(3), order(4)),
   R("GET", "/openApi/swap/v2/trade/order", {"code": 0, "msg": "", "data": {"order": {"orderId": 5, "status": "NEW"}}}),
   R("GET", "/openApi/swap/v2/user/positions", pos()),
   R("GET", "/openApi/swap/v2/trade/openOrders", oo({"type": "TAKE_PROFIT_MARKET", "side": "SELL"}))])
S("pt_sl_101204_not_found", PT, LONG, {"trade_id": "bx-12", "user_id": 3},
  [C, B, L, R("POST", "/openApi/swap/v2/trade/batchOrders", BATCH_SIG), R("GET", "/openApi/swap/v2/quote/price", price("87000")),
   R("POST", "/openApi/swap/v2/trade/order", order(), err(101204, "Insufficient margin")),
   R("GET", "/openApi/swap/v2/trade/order", err(109414, "order not exist")),
   R("GET", "/openApi/swap/v2/user/positions", pos()),
   R("DELETE", "/openApi/swap/v2/trade/allOpenOrders", {"code": 0, "msg": "", "data": {"orders": []}})])
S("pt_symbol_missing", PT, [KEY, SEC, "NOPE-USDT-SWAP", "LONG", 1.0, 0.9, 1.2, 1.0, 5], {}, [C])
S("pt_balance_error", PT, LONG, {}, [C, R("GET", "/openApi/swap/v2/user/balance", err(100413, "Incorrect apiKey"))])
S("pt_low_notional_skip", PT, LONG, {}, [C, R("GET", "/openApi/swap/v2/user/balance", bal("20.0")), L])
S("pt_low_notional_boost_market", PT, [KEY, SEC, "ETH-USDT-SWAP", "LONG", 3000.0, 2900.0, 3200.0, 0.1, 5],
  {"allow_low_notional_boost": True},
  [C, R("GET", "/openApi/swap/v2/user/balance", bal("100")), L, R("GET", "/openApi/swap/v2/quote/price", price("2900")),
   R("POST", "/openApi/swap/v2/trade/order", order(), order(2), order(3)),
   R("GET", "/openApi/swap/v2/user/positions", pos("ETH-USDT", "0.01")),
   R("GET", "/openApi/swap/v2/trade/openOrders", oo({"type": "TAKE_PROFIT_MARKET", "side": "SELL"}))])
S("pt_pepe_live_short", PT, [KEY, SEC, "PEPE-USDT-SWAP", "SHORT", 0.00000391, 0.00000402, 0.0000037, 1.5, 5], {"tp2": 0.0000036},
  [C, B, L, R("GET", "/openApi/swap/v2/quote/price", price("0.0039105")),
   R("POST", "/openApi/swap/v2/trade/order", order(), order(2), order(3), order(4)),
   R("GET", "/openApi/swap/v2/user/positions", pos("1000PEPE-USDT", "-1364000", "SHORT")),
   R("GET", "/openApi/swap/v2/trade/openOrders", oo({"type": "TAKE_PROFIT_MARKET", "side": "BUY"}, {"type": "TAKE_PROFIT_MARKET", "side": "BUY"}))],
  state={"live_bingx": ["1000PEPE-USDT", "BTC-USDT", "ETH-USDT"]})
S("pt_ton_alias", PT, [KEY, SEC, "TON-USDT-SWAP", "LONG", 5.0, 4.8, 5.5, 1.0, 100], {},
  [C, B, L, R("GET", "/openApi/swap/v2/quote/price", price("5.001")),
   R("POST", "/openApi/swap/v2/trade/order", order(), order(2), order(3)),
   R("GET", "/openApi/swap/v2/user/positions", pos("TONCOIN-USDT", "50")),
   R("GET", "/openApi/swap/v2/trade/openOrders", oo({"type": "TAKE_PROFIT_MARKET", "side": "SELL"}))])
S("pt_network_retry_then_fail", PT, LONG, {},
  [C, R("GET", "/openApi/swap/v2/user/balance", {"raise": "connect", "message": "Cannot connect to host open-api.bingx.com:443 ssl:default [Name or service not known]"})])
S("pt_html_502_balance", PT, LONG, {},
  [C, R("GET", "/openApi/swap/v2/user/balance", {"status": 502, "text": "<html>Bad Gateway</html>", "headers": {"Content-Type": "text/html"}})])
S("pt_killswitch", PT, LONG, {}, [], state={"ks_halted": "HALTED_ALL"})
S("pt_order_rejected", PT, LONG, {},
  [C, B, L, R("GET", "/openApi/swap/v2/quote/price", price("87000")),
   R("POST", "/openApi/swap/v2/trade/order", err(101204, "Insufficient margin"))])
S("pt_order_rejected_generic", PT, LONG, {},
  [C, B, L, R("GET", "/openApi/swap/v2/quote/price", price("87000")),
   R("POST", "/openApi/swap/v2/trade/order", err(1, "something odd"))])

# ── trailing / BE / SL+TP for position ──
S("trail_long_ok", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 86500.0, "LONG", 0],
  routes=[C, R("GET", "/openApi/swap/v2/user/positions", pos()), R("POST", "/openApi/swap/v2/trade/order", order(777)),
          R("GET", "/openApi/swap/v2/trade/openOrders", oo({"orderId": 777, "type": "STOP_MARKET", "side": "SELL"},
                                                          {"orderId": 555, "type": "STOP_MARKET", "side": "SELL"},
                                                          {"orderId": 556, "type": "TAKE_PROFIT_MARKET", "side": "SELL"})),
          R("DELETE", "/openApi/swap/v2/trade/order", err(109400, "order not exist"))])
S("trail_110424", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 86500.0, "LONG", 0],
  routes=[C, R("GET", "/openApi/swap/v2/user/positions", pos()), R("POST", "/openApi/swap/v2/trade/order", err(110424, "order size > available"))])
S("trail_no_position", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 86500.0, "SHORT", 0],
  routes=[C, R("GET", "/openApi/swap/v2/user/positions", NOPOS)])
S("trail_lock_109500", "set_trailing_sl", [KEY, SEC, "ETH-USDT-SWAP", 3100.0, "SHORT", 0],
  routes=[C, R("GET", "/openApi/swap/v2/user/positions", pos("ETH-USDT", "-2.5", "BOTH")),
          R("POST", "/openApi/swap/v2/trade/order", err(109500, "lock fail"), err(109400, "positionSide"), order(5)),
          R("GET", "/openApi/swap/v2/trade/openOrders", oo())])
S("trail_qty_zero", "set_trailing_sl", [KEY, SEC, "ASTER-USDT-SWAP", 1.2, "LONG", 0],
  routes=[C, R("GET", "/openApi/swap/v2/user/positions", pos("ASTER-USDT", "1.86"))])
S("breakeven_short", "set_breakeven", [KEY, SEC, "ETH-USDT-SWAP", 3000.123, "SHORT", 0],
  routes=[C, R("GET", "/openApi/swap/v2/trade/openOrders", oo({"orderId": 1, "type": "STOP_MARKET", "side": "BUY"})),
          R("DELETE", "/openApi/swap/v2/trade/order", {"code": 0, "msg": "", "data": {}}),
          R("GET", "/openApi/swap/v2/user/positions", pos("ETH-USDT", "-2.5", "SHORT")),
          R("POST", "/openApi/swap/v2/trade/order", order(9))])
S("sltp_for_position", "place_sl_tp_for_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.0115, 86000.0, 88500.0, 89500.0, 90500.0],
  routes=[C, R("POST", "/openApi/swap/v2/trade/order", order(41), order(42), err(110413, "tp below"), order(43), order(44)),
          R("GET", "/openApi/swap/v2/trade/openOrders",
            oo({"orderId": 41, "type": "STOP_MARKET", "side": "SELL"}, {"orderId": 7, "type": "STOP_MARKET", "side": "SELL"},
               {"orderId": 8, "type": "TAKE_PROFIT_MARKET", "side": "SELL"}),
            oo({"type": "TAKE_PROFIT_MARKET", "side": "SELL"}, {"type": "TAKE_PROFIT_MARKET", "side": "SELL"})),
          R("DELETE", "/openApi/swap/v2/trade/order", {"code": 0, "msg": "", "data": {}})])

# ── close / cancel / reads ──
S("close_long_rounded", "close_position", [KEY, SEC, "ASTER-USDT-SWAP", "LONG", 5.7],
  routes=[C, R("POST", "/openApi/swap/v2/trade/order", order(61))])
S("close_short_109400_both", "close_position", [KEY, SEC, "ETH-USDT-SWAP", "SHORT", 2.555],
  routes=[C, R("POST", "/openApi/swap/v2/trade/order", err(109400, "positionSide"), order(62))])
S("close_below_step", "close_position", [KEY, SEC, "ASTER-USDT-SWAP", "LONG", 1.86], routes=[C])
S("close_error", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.5],
  routes=[C, R("POST", "/openApi/swap/v2/trade/order", err(101514, "position not exist"))])
S("cancel_all", "cancel_all_orders", [KEY, SEC, "BTC-USDT-SWAP"],
  routes=[R("DELETE", "/openApi/swap/v2/trade/allOpenOrders", {"code": 0, "msg": "", "data": {"orders": [{"orderId": 1}, {"orderId": 2}]}})])
S("cancel_all_timeout_retry", "cancel_all_orders", [KEY, SEC, "BTC-USDT-SWAP"],
  routes=[R("DELETE", "/openApi/swap/v2/trade/allOpenOrders", {"raise": "timeout"}, {"json": {"code": 0, "msg": "", "data": {"orders": []}}})],
  random=[0.9])
S("cancel_tp_only", "cancel_tp_orders_only", [KEY, SEC, "BTC-USDT-SWAP"],
  routes=[R("GET", "/openApi/swap/v2/trade/openOrders", oo({"orderId": OID, "type": "TAKE_PROFIT_MARKET"}, {"orderId": 2, "type": "STOP_MARKET"},
                                                          {"orderId": 3, "type": "take_profit_market"}, {"orderId": "", "type": "TAKE_PROFIT_MARKET"})),
          R("DELETE", "/openApi/swap/v2/trade/order", {"code": 0, "msg": "", "data": {}}, err(109400, "order not exist"))])
S("cancel_order", "cancel_order", [KEY, SEC, "BTC-USDT-SWAP", "123"],
  routes=[R("DELETE", "/openApi/swap/v2/trade/order", err(109400, "order not exist"))])
S("get_positions_all", "get_positions", [KEY, SEC],
  routes=[R("GET", "/openApi/swap/v2/user/positions", {"code": 0, "msg": "", "data": [
      {"symbol": "BTC-USDT", "positionSide": "LONG", "positionAmt": "0.5", "avgPrice": "87000", "markPrice": "87100", "unrealizedProfit": "50", "leverage": 10},
      {"symbol": "ETH-USDT", "positionSide": "SHORT", "positionAmt": "0", "avgPrice": "3000"},
      {"symbol": "SOL-USDT", "positionSide": "BOTH", "positionAmt": "-3", "avgPrice": "150", "leverage": "5"}]})])
S("get_positions_bad_leverage", "get_positions", [KEY, SEC, "BTC-USDT-SWAP"],
  routes=[R("GET", "/openApi/swap/v2/user/positions", {"code": 0, "msg": "", "data": [{"symbol": "BTC-USDT", "positionAmt": "1", "leverage": "10.5"}]})])
S("get_balance", "get_balance", [KEY, SEC], routes=[B])
S("get_balance_err", "get_balance", [KEY, SEC], routes=[R("GET", "/openApi/swap/v2/user/balance", err(100001, "Signature verification failed"))])
S("get_last_price", "get_last_price", [KEY, SEC, "BTC-USDT-SWAP"], routes=[R("GET", "/openApi/swap/v2/quote/price", price("87123.4"))])
S("get_closed_pnl", "get_closed_pnl", [KEY, SEC, "BTC-USDT-SWAP"],
  routes=[R("GET", "/openApi/swap/v2/trade/allOrders", {"code": 0, "msg": "", "data": {"orders": [
      {"side": "SELL", "avgPrice": "88000", "updateTime": 1767225000000, "profit": "12.5", "clientOrderId": "chm_x"},
      {"side": "BUY", "avgPrice": "0", "price": "87000", "time": 1767224000000, "profit": ""},
      {"side": "BUY", "avgPrice": "", "price": "0"},
      {"side": "sell", "price": "86000", "profit": "bad"}]}})])
S("get_open_orders", "get_open_orders", [KEY, SEC],
  routes=[R("GET", "/openApi/swap/v2/trade/openOrders", oo({"orderId": OID, "symbol": "BTC-USDT", "type": "LIMIT"}))])
S("dashboard_with_penalty", "get_dashboard", [KEY, SEC],
  routes=[R("GET", "/openApi/swap/v2/user/positions", {"raise": "error", "message": "429, message='Too Many Requests', url='https://open-api.bingx.com'"}),
          R("GET", "/openApi/swap/v2/trade/openOrders", oo({"orderId": 1, "symbol": "BTC-USDT", "side": "SELL", "type": "LIMIT", "price": "88000", "origQty": "0.1"})),
          B, R("GET", "/openApi/swap/v2/trade/allFillOrders", {"code": 0, "msg": "", "data": {"fill_orders": [{"profit": "1.1"}, {"profit": "-0.3"}, {"profit": "2.2"}]}})])
S("test_connection_v1_fallback", "test_connection", [KEY, SEC],
  routes=[R("GET", "/openApi/swap/v2/user/balance", err(100500, "internal")),
          R("GET", "/openApi/swap/v1/user/balance", {"code": 0, "msg": "", "data": [{"balance": "77.5"}]})])
S("test_connection_bad_key", "test_connection", ["gAAAAAbroken", SEC], routes=[])
S("sync_time", "sync_time", [], routes=[R("GET", "/openApi/server/v1/time", {"code": 0, "msg": "", "data": {"serverTime": 1767225600420}})])
S("sync_time_missing_data", "sync_time", [], routes=[R("GET", "/openApi/server/v1/time", {"code": 100, "msg": "maintenance"})])
