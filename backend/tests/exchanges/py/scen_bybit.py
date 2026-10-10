"""Bybit replay scenarios (see harness.py for the format)."""

KEY, SEC = "BYBITKEY123456789", "bybit-secret-xyz"

T = {"retCode": 0, "retMsg": "OK", "result": {"timeSecond": "1767225600", "timeNano": "1767225600250000000"}}
SWITCH_NM = {"retCode": 110026, "retMsg": "Cross/isolated margin mode is not modified", "result": {}}
LEV_NM = {"retCode": 110043, "retMsg": "leverage not modified", "result": {}}
LEV_OK = {"retCode": 0, "retMsg": "OK", "result": {}}


def wallet(total="1000.5", avail="800.25", coin_avail=""):
    return {"retCode": 0, "retMsg": "OK", "result": {"list": [{
        "totalEquity": total, "totalAvailableBalance": avail, "totalWalletBalance": total, "totalUnrealisedPnl": "1.5",
        "coin": [{"coin": "USDT", "walletBalance": total, "equity": total, "availableBalance": coin_avail, "availableToWithdraw": ""}]}]}}


def instr(step="0.001", tick="0.1"):
    return {"retCode": 0, "retMsg": "OK", "result": {"list": [{"lotSizeFilter": {"qtyStep": step}, "priceFilter": {"tickSize": tick}}]}}


def order_ok(oid="ord-1"):
    return {"retCode": 0, "retMsg": "OK", "result": {"orderId": oid, "orderLinkId": ""}}


def positions(sym="BTCUSDT", size="0.012", idx=0, avg="87000.5", side="Buy"):
    return {"retCode": 0, "retMsg": "OK", "result": {"list": [{"symbol": sym, "side": side, "size": size, "positionIdx": idx, "avgPrice": avg, "markPrice": avg, "stopLoss": ""}]}}


def err(code, msg):
    return {"retCode": code, "retMsg": msg, "result": {}}


def R(method, path, *resps, query=None):
    r = {"method": method, "path": path, "responses": [x if ("raise" in x or "status" in x or "json" in x or "text" in x) else {"json": x} for x in resps]}
    if query:
        r["query"] = query
    return r


BASE_ROUTES = [
    R("GET", "/v5/market/time", T),
    R("POST", "/v5/position/switch-isolated", SWITCH_NM),
    R("POST", "/v5/position/set-leverage", LEV_NM),
    R("GET", "/v5/account/wallet-balance", wallet()),
    R("GET", "/v5/market/instruments-info", instr()),
]

SCENARIOS = []


def S(name, call, args, kwargs=None, routes=None, state=None, mode="wire", random=None, clock=1767225600.0):
    SCENARIOS.append({"name": name, "exchange": "bybit", "call": call, "args": args, "kwargs": kwargs or {},
                      "routes": routes or [], "state": state or {}, "mode": mode, "random": random or [], "clock": clock})


PT = "place_trade"
LONG_ARGS = [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86000.0, 88500.0, 1.0, 10]

S("pt_long_limit_atomic_ladder", PT, LONG_ARGS, {"tp2": 89500.0, "tp3": 90500.0, "trade_id": "tr-1", "user_id": 42},
  BASE_ROUTES + [R("POST", "/v5/order/create", order_ok("ord-entry"), order_ok("ord-tp2"), order_ok("ord-tp3")),
                 R("GET", "/v5/position/list", positions())])
S("pt_short_market_no_tps", PT, [KEY, SEC, "ETH-USDT-SWAP", "SHORT", 3000.0, 3060.0, 0.0, 2.0, 20],
  {"order_type": "Market", "trade_id": "tr-2", "user_id": 7},
  BASE_ROUTES + [R("POST", "/v5/order/create", order_ok("m-1")),
                 R("GET", "/v5/position/list", positions("ETHUSDT", "6.66", 0, "2999.5", "Sell"))])
S("pt_long_market_hedge_tp1_only", PT, LONG_ARGS, {"order_type": "Market"},
  BASE_ROUTES + [R("POST", "/v5/order/create", order_ok("h-1"), order_ok("h-tp")),
                 R("GET", "/v5/position/list", positions(idx=1))],
  state={"hedge": {KEY: True}})
S("pt_pepe_short_limit", PT, [KEY, SEC, "PEPE-USDT-SWAP", "SHORT", 0.00000391, 0.00000402, 0.00000370, 1.5, 5],
  {"tp2": 0.0000036, "tp3": 0.0000035, "trade_id": "pepe-1", "user_id": 9},
  [R("GET", "/v5/market/time", T), R("POST", "/v5/position/switch-isolated", SWITCH_NM),
   R("POST", "/v5/position/set-leverage", LEV_OK), R("GET", "/v5/account/wallet-balance", wallet("250.0", "200")),
   R("GET", "/v5/market/instruments-info", instr("100", "0.0000001")),
   R("POST", "/v5/order/create", order_ok("p-1"), order_ok("p-2"), order_ok("p-3")),
   R("GET", "/v5/position/list", positions("1000PEPEUSDT", "3409000", 0, "0.00391", "Sell"))])
S("pt_low_notional_skip", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 80000.0, 88500.0, 0.5, 10], {},
  [R("GET", "/v5/market/time", T), R("POST", "/v5/position/switch-isolated", SWITCH_NM),
   R("POST", "/v5/position/set-leverage", LEV_NM), R("GET", "/v5/account/wallet-balance", wallet("50.0", "50"))])
S("pt_low_notional_boost", PT, [KEY, SEC, "XRP-USDT-SWAP", "LONG", 2.5, 2.4, 2.7, 0.5, 10], {"allow_low_notional_boost": True},
  [R("GET", "/v5/market/time", T), R("POST", "/v5/position/switch-isolated", SWITCH_NM),
   R("POST", "/v5/position/set-leverage", LEV_NM), R("GET", "/v5/account/wallet-balance", wallet("100.0", "90")),
   R("GET", "/v5/market/instruments-info", instr("1", "0.0001")),
   R("POST", "/v5/order/create", order_ok("x-1")),
   R("GET", "/v5/position/list", positions("XRPUSDT", "4", 0, "2.5"))])
S("pt_leverage_downgrade", PT, [KEY, SEC, "SOL-USDT-SWAP", "LONG", 150.0, 145.0, 160.0, 1.0, 50], {},
  [R("GET", "/v5/market/time", T), R("POST", "/v5/position/switch-isolated", LEV_OK),
   R("POST", "/v5/position/set-leverage", err(10001, "cannot set leverage [5000] gt maxLeverage [2500] by risk limit"), LEV_OK),
   R("GET", "/v5/account/wallet-balance", wallet()), R("GET", "/v5/market/instruments-info", instr("0.1", "0.01")),
   R("POST", "/v5/order/create", order_ok("s-1")), R("GET", "/v5/position/list", positions("SOLUSDT", "2", 0, "150"))])
S("pt_leverage_permission", PT, LONG_ARGS, {},
  [R("GET", "/v5/market/time", T), R("POST", "/v5/position/switch-isolated", SWITCH_NM),
   R("POST", "/v5/position/set-leverage", err(10005, "Permission denied, please check your API key permissions."))])
S("pt_order_insufficient_110007", PT, LONG_ARGS, {"tp2": 89500.0},
  BASE_ROUTES + [R("POST", "/v5/order/create", err(110007, "ab not enough for new order"))])
S("pt_order_delisting_30228", PT, [KEY, SEC, "LUNA-USDT-SWAP", "SHORT", 0.5, 0.52, 0.45, 1.0, 5], {},
  BASE_ROUTES[:3] + [R("GET", "/v5/account/wallet-balance", wallet()), R("GET", "/v5/market/instruments-info", instr("1", "0.0001")),
                     R("POST", "/v5/order/create", err(30228, "No new positions during delisting."))])
S("pt_order_130125_wire_raises", PT, LONG_ARGS, {},
  BASE_ROUTES + [R("POST", "/v5/order/create", err(130125, "position idx not match position mode"))])
S("pt_contract_account_sl_ok", PT, LONG_ARGS, {"tp2": 89500.0, "tp3": 90500.0},
  [R("GET", "/v5/market/time", T), R("POST", "/v5/position/switch-isolated", SWITCH_NM), R("POST", "/v5/position/set-leverage", LEV_NM),
   R("GET", "/v5/account/wallet-balance", err(10001, "accountType only support UNIFIED"), wallet("700.0", "650", "650")),
   R("GET", "/v5/market/instruments-info", instr()),
   R("POST", "/v5/order/create", order_ok("c-1"), order_ok("c-2"), order_ok("c-3")),
   R("GET", "/v5/position/list", positions()),
   R("POST", "/v5/position/trading-stop", LEV_OK)],
  state={"account_type": {KEY: "CONTRACT"}})
S("pt_contract_sl_fail_safety_close", PT, LONG_ARGS, {"tp2": 89500.0},
  [R("GET", "/v5/market/time", T), R("POST", "/v5/position/switch-isolated", SWITCH_NM), R("POST", "/v5/position/set-leverage", LEV_NM),
   R("GET", "/v5/account/wallet-balance", wallet("700.0", "650", "650")),
   R("GET", "/v5/market/instruments-info", instr()),
   R("POST", "/v5/order/create", order_ok("c-1"), order_ok("c-2"), order_ok("close-1")),
   R("GET", "/v5/position/list", positions()),
   R("POST", "/v5/position/trading-stop", err(10001, "Invalid stopLoss"))],
  state={"account_type": {KEY: "CONTRACT"}})
S("pt_available_margin_insufficient", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86900.0, 88500.0, 3.0, 1], {},
  [R("GET", "/v5/market/time", T), R("POST", "/v5/position/switch-isolated", SWITCH_NM), R("POST", "/v5/position/set-leverage", LEV_NM),
   R("GET", "/v5/account/wallet-balance", wallet("100000.0", "1500.123")), R("GET", "/v5/market/instruments-info", instr())])
S("pt_margin_85pct", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86990.0, 88500.0, 1.0, 1], {},
  [R("GET", "/v5/market/time", T), R("POST", "/v5/position/switch-isolated", SWITCH_NM), R("POST", "/v5/position/set-leverage", LEV_NM),
   R("GET", "/v5/account/wallet-balance", wallet("1000.0", "1000")), R("GET", "/v5/market/instruments-info", instr())])
S("pt_tight_sl_zero_qty", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86999.5, 88500.0, 0.0001, 10], {"allow_low_notional_boost": False},
  [R("GET", "/v5/market/time", T), R("POST", "/v5/position/switch-isolated", SWITCH_NM), R("POST", "/v5/position/set-leverage", LEV_NM),
   R("GET", "/v5/account/wallet-balance", wallet("100000.0", "100000")), R("GET", "/v5/market/instruments-info", instr("1", "0.1"))])
S("pt_balance_network_error", PT, LONG_ARGS, {},
  [R("GET", "/v5/market/time", T), R("POST", "/v5/position/switch-isolated", SWITCH_NM), R("POST", "/v5/position/set-leverage", LEV_NM),
   R("GET", "/v5/account/wallet-balance", {"raise": "connect", "message": "HTTPSConnectionPool(host='api.bybit.com', port=443): Max retries exceeded (Caused by NameResolutionError)"})])
S("pt_tp2_110017_flash_close", PT, LONG_ARGS, {"tp2": 89500.0, "tp3": 90500.0},
  BASE_ROUTES + [R("POST", "/v5/order/create", order_ok("e-1"), err(110017, "current position is zero, cannot fix reduce-only order qty")),
                 R("GET", "/v5/position/list", positions(), positions(), positions(size="0"))])
S("pt_rate_limit_10006", PT, LONG_ARGS, {},
  BASE_ROUTES + [R("POST", "/v5/order/create", {"json": err(10006, "Too many visits!"), "headers": {"X-Bapi-Limit-Reset-Timestamp": "1767225602500"}})])
S("pt_killswitch_halted", PT, LONG_ARGS, {}, [], state={"ks_halted": "HALTED_NEW"})
S("pt_plan_gate_denied", PT, LONG_ARGS, {"user_id": 5}, [],
  state={"plan_deny": {"ok": False, "order_id": "", "error": "plan_gate: free disallows auto_trade", "plan_gate_blocked": True}})
S("pt_auth_10003", PT, LONG_ARGS, {},
  BASE_ROUTES[:3] + [R("GET", "/v5/account/wallet-balance", err(10003, "API key is invalid."))],
  state={"auth_uids": [11, 12]})
S("pt_http_403", PT, LONG_ARGS, {},
  BASE_ROUTES[:3] + [R("GET", "/v5/account/wallet-balance", {"status": 403, "text": "Forbidden", "headers": {"Content-Type": "text/html"}})])
S("pt_kv_hedge_warm", PT, LONG_ARGS, {"order_type": "Market"},
  BASE_ROUTES + [R("POST", "/v5/order/create", order_ok("k-1"), order_ok("k-tp")),
                 R("GET", "/v5/position/list", positions(idx=1))],
  state={"kv_hedge": True})
S("pt_token_bucket_exhaustion", PT, LONG_ARGS, {"tp2": 89500.0, "tp3": 90500.0},
  BASE_ROUTES + [R("POST", "/v5/order/create", order_ok("b-1"), order_ok("b-2"), order_ok("b-3")),
                 R("GET", "/v5/position/list", positions(size="0"), positions(size="0"), positions(size="0"), positions(size="0"),
                   positions(size="0"), positions(size="0"), positions(size="0"), positions(size="0"), positions(size="0"),
                   positions(size="0"), positions(size="0"), positions(size="0"), positions(size="0"), positions())])

# ── split ──
S("split_long_unified", "place_trade_split", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 86500.0, 87000.0, 85500.0, 88500.0, 1.0, 10],
  {"tp2": 89500.0, "tp3": 90500.0},
  BASE_ROUTES + [R("POST", "/v5/order/create", order_ok("lo-1"), order_ok("hi-1"), order_ok("t1"), order_ok("t2"), order_ok("t3")),
                 R("GET", "/v5/position/list", positions(size="0.016"))])
S("split_short_one_leg_fails", "place_trade_split", [KEY, SEC, "ETH-USDT-SWAP", "SHORT", 3010.0, 3030.0, 3080.0, 2950.0, 1.0, 10], {},
  BASE_ROUTES + [R("POST", "/v5/order/create", err(110007, "ab not enough for new order"), order_ok("hi-2"), order_ok("tp")),
                 R("GET", "/v5/position/list", positions("ETHUSDT", "0.84", 0, "3030", "Sell"))])

# ── SL management ──
TICK_MARK = lambda mark: {"retCode": 0, "retMsg": "OK", "result": {"list": [{"symbol": "BTCUSDT", "markPrice": mark, "lastPrice": mark, "bid1Price": "86999.5", "ask1Price": "87000.5", "fundingRate": "0.0001"}]}}  # noqa: E731
S("trail_long_ok", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 86500.0, "LONG", 0],
  routes=[R("GET", "/v5/market/instruments-info", instr()), R("GET", "/v5/market/tickers", TICK_MARK("87000.0")),
          R("POST", "/v5/position/trading-stop", LEV_OK)])
S("trail_34040", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 86500.0, "LONG", 0],
  routes=[R("GET", "/v5/market/instruments-info", instr()), R("GET", "/v5/market/tickers", TICK_MARK("87000.0")),
          R("POST", "/v5/position/trading-stop", err(34040, "not modified"))])
S("trail_precheck_wrong_side", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 87100.0, "LONG", 0],
  routes=[R("GET", "/v5/market/instruments-info", instr()), R("GET", "/v5/market/tickers", TICK_MARK("87000.0"))])
S("trail_short_110010_retry", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 87500.0, "SHORT", 2],
  routes=[R("GET", "/v5/market/instruments-info", instr()), R("GET", "/v5/market/tickers", TICK_MARK("87000.0")),
          R("POST", "/v5/position/trading-stop", err(110010, "StopLoss for Sell position should greater base_price"), LEV_OK)])
S("trail_pepe_110010_abort", "set_trailing_sl", [KEY, SEC, "PEPE-USDT-SWAP", 0.0000040, "SHORT", 0],
  routes=[R("GET", "/v5/market/instruments-info", instr("100", "0.0000001")),
          R("GET", "/v5/market/tickers", TICK_MARK("0.00390"), TICK_MARK("0.00405")),
          R("POST", "/v5/position/trading-stop", err(110010, "invalid"))])
S("breakeven_short", "set_breakeven", [KEY, SEC, "ETH-USDT-SWAP", 3000.123, "SHORT", 2],
  routes=[R("GET", "/v5/market/instruments-info", instr("0.01", "0.01")), R("POST", "/v5/position/trading-stop", LEV_OK)])

# ── close / cancel / reads ──
S("close_long_rounding", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", "0.0123", 0],
  routes=[R("GET", "/v5/market/instruments-info", instr()), R("POST", "/v5/order/create", order_ok("cl-1"))])
S("close_sell_10001_benign", "close_position", [KEY, SEC, "ETH-USDT-SWAP", "Sell", 1.5, 2],
  routes=[R("GET", "/v5/market/instruments-info", instr("0.01", "0.01")), R("POST", "/v5/order/create", err(10001, "Qty invalid"))])
S("close_below_step", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "SHORT", "0.0004", 0],
  routes=[R("GET", "/v5/market/instruments-info", instr())])
S("close_unknown_side", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "FLAT", "1", 0])
S("cancel_all_ok", "cancel_all_orders", [KEY, SEC, "BTC-USDT-SWAP"],
  routes=[R("POST", "/v5/order/cancel-all", {"retCode": 0, "retMsg": "OK", "result": {"list": [{"orderId": "a"}, {"orderId": "b"}]}})])
S("cancel_all_timeout_retry", "cancel_all_orders", [KEY, SEC, "BTC-USDT-SWAP", True],
  routes=[R("POST", "/v5/order/cancel-all", {"raise": "timeout", "message": "HTTPSConnectionPool(host='api-demo.bybit.com', port=443): Read timed out. (read timeout=10)"},
            {"json": {"retCode": 0, "retMsg": "OK", "result": {"list": []}}})], random=[0.25])
S("cancel_order_110001", "cancel_order", [KEY, SEC, "BTC-USDT-SWAP", "oid-9"],
  routes=[R("POST", "/v5/order/cancel", err(110001, "order not exists or too late to cancel"))])
S("get_positions_symbol", "get_positions", [KEY, SEC, "PEPE-USDT-SWAP"],
  routes=[R("GET", "/v5/position/list", positions("1000PEPEUSDT", "1000", 0, "0.0039", "Buy"))])
S("get_open_orders", "get_open_orders", [KEY, SEC],
  routes=[R("GET", "/v5/order/realtime", {"retCode": 0, "retMsg": "OK", "result": {"list": [{"orderId": "o1", "symbol": "BTCUSDT", "side": "Sell", "orderType": "Limit", "reduceOnly": True}]}})])
S("get_closed_pnl_empty", "get_closed_pnl", [KEY, SEC, "BTC-USDT-SWAP"],
  routes=[R("GET", "/v5/position/closed-pnl", {"retCode": 0, "retMsg": "OK", "result": {"list": []}})])
S("get_closed_pnl_exc", "get_closed_pnl", [KEY, SEC, "BTC-USDT-SWAP"],
  routes=[R("GET", "/v5/position/closed-pnl", err(10003, "Invalid api key"))])
S("get_balance_unified", "get_balance", [KEY, SEC], routes=[R("GET", "/v5/account/wallet-balance", wallet("1234.5678"))])
S("get_balance_contract_coin", "get_balance", [KEY, SEC, True],
  routes=[R("GET", "/v5/account/wallet-balance", err(10001, "bad acct"), {"json": {"retCode": 0, "result": {"list": [{"totalEquity": "", "coin": [{"coin": "BTC"}, {"coin": "USDT", "walletBalance": "", "equity": "321.5"}]}]}}})])
S("get_balance_retryable_resync", "get_balance", [KEY, SEC],
  routes=[R("GET", "/v5/account/wallet-balance", err(10002, "invalid request, please check your server timestamp or recv_window param"), wallet("55.5")),
          R("GET", "/v5/market/time", T)])
S("exec_exit_price", "get_execution_exit_price", [KEY, SEC, "BTC-USDT-SWAP", 1767225500000.0],
  routes=[R("GET", "/v5/execution/list", {"retCode": 0, "retMsg": "OK", "result": {"list": [
      {"execTime": "1767225400000", "closedSize": "1", "execPrice": "1"},
      {"execTime": "1767225550000", "closedSize": "0.004", "execPrice": "87100.1"},
      {"execTime": "1767225560000", "closedSize": "0.008", "execPrice": "87150.3"},
      {"execTime": "1767225570000", "closedSize": "0", "execPrice": "87000"}]}})])
S("dashboard", "get_dashboard", [KEY, SEC],
  routes=[R("GET", "/v5/market/time", T), R("GET", "/v5/position/list", positions()),
          R("GET", "/v5/order/realtime", {"retCode": 0, "result": {"list": []}}),
          R("GET", "/v5/account/wallet-balance", wallet()),
          R("GET", "/v5/position/closed-pnl", {"retCode": 0, "result": {"list": [{"closedPnl": "1.25"}, {"closedPnl": "-0.5"}, {"closedPnl": "2"}]}})])
S("test_connection_live_ok", "test_connection", [KEY, SEC],
  routes=[R("GET", "/v5/market/time", T), R("GET", "/v5/account/wallet-balance", wallet("500", "400", "450.5"))])
S("test_connection_switch_to_demo", "test_connection", [KEY, SEC, False],
  routes=[R("GET", "/v5/market/time", T),
          R("GET", "/v5/account/wallet-balance", {"json": err(10003, "API key is invalid.")}, {"json": err(10003, "API key is invalid.")},
            {"json": wallet("900", "800", "850")})])
S("test_connection_http_down", "test_connection", [KEY, SEC],
  routes=[R("GET", "/v5/market/time", {"status": 502, "text": "bad gateway", "headers": {"Content-Type": "text/html"}})])
S("place_tp_orders_phantom", "place_tp_orders", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.012, 88500.0, 89500.0, 90500.0, 0],
  routes=[R("GET", "/v5/market/instruments-info", instr()), R("GET", "/v5/position/list", positions()),
          R("POST", "/v5/order/create", order_ok("t1"), order_ok("t2"), order_ok("t3")),
          R("GET", "/v5/order/realtime", {"retCode": 0, "result": {"list": [
              {"symbol": "BTCUSDT", "reduceOnly": True, "orderType": "Limit", "side": "Sell"}]}})])

# ── session-mode (dict-returning pybit stand-in, like the bot's unit tests) ──
SC = lambda name, *resps: R("CALL", "/" + name, *resps)  # noqa: E731
SESSION_BASE = [R("GET", "/v5/market/time", T), SC("switch_margin_mode", err(110026, "nm")), SC("set_leverage", LEV_OK),
                SC("get_wallet_balance", wallet()), SC("get_instruments_info", instr())]
S("sess_atomic_fallback", PT, LONG_ARGS, {"tp2": 89500.0, "trade_id": "tr-9", "user_id": 1},
  SESSION_BASE + [SC("place_order", err(10001, "takeProfit invalid for symbol"), order_ok("af-1"), order_ok("af-tp1"), order_ok("af-tp2")),
                  SC("get_positions", positions())], mode="session")
S("sess_130125_flip_to_hedge", PT, LONG_ARGS, {"order_type": "Market"},
  SESSION_BASE + [SC("place_order", err(130125, "position idx not match position mode"), order_ok("fl-1"), order_ok("fl-tp")),
                  SC("get_positions", positions(idx=1))], mode="session")
S("sess_130125_flip_to_oneway", PT, LONG_ARGS, {"order_type": "Market"},
  SESSION_BASE + [SC("place_order", err(130125, "position idx not match position mode"), order_ok("fo-1"), order_ok("fo-tp")),
                  SC("get_positions", positions(idx=0))], mode="session", state={"hedge": {KEY: True}})
S("sess_duplicate_link", PT, LONG_ARGS, {"trade_id": "dup-1", "user_id": 3},
  SESSION_BASE + [SC("place_order", err(110072, "OrderLinkedID is duplicate")), SC("get_positions", positions())], mode="session")
S("sess_duplicate_no_position", PT, LONG_ARGS, {"trade_id": "dup-2", "user_id": 3},
  SESSION_BASE + [SC("place_order", err(110072, "OrderLinkedID is duplicate")), SC("get_positions", positions(size="0"))], mode="session")
S("sess_10001_twice_contract", PT, LONG_ARGS, {},
  SESSION_BASE + [SC("place_order", err(10001, "params error: side invalid"), err(10001, "params error"), order_ok("ct-1"))], mode="session")
S("sess_10001_transient", PT, LONG_ARGS, {"tp2": 89500.0},
  SESSION_BASE + [SC("place_order", err(10001, "params error: x"), order_ok("tr-1"), order_ok("tr-tp")),
                  SC("get_positions", positions())], mode="session")
S("sess_delisted_110074", PT, LONG_ARGS, {}, SESSION_BASE + [SC("place_order", err(110074, "contract is not live"))], mode="session")
S("sess_10001_symbol_fail", PT, LONG_ARGS, {}, SESSION_BASE + [SC("place_order", err(170214, "symbol invalid"))], mode="session")
S("sess_close_10001_dict", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "Buy", "0.5", 0],
  routes=[SC("get_instruments_info", instr()), SC("place_order", err(10001, "Qty invalid"))], mode="session")
S("sess_trail_34040_dict", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 86500.0, "LONG", 0],
  routes=[SC("get_instruments_info", instr()), SC("get_tickers", TICK_MARK("87000")), SC("set_trading_stop", err(34040, "not modified"))], mode="session")
S("sess_split_130125", "place_trade_split", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 86500.0, 87000.0, 85500.0, 88500.0, 1.0, 10], {},
  SESSION_BASE + [SC("place_order", err(130125, "pos idx"), order_ok("lo"), order_ok("hi"), order_ok("tp")),
                  SC("get_positions", positions(idx=1, size="0.016"))], mode="session")


# ── [POS-READ-STRICT 2026-10] strict positions read: None + the error text on a failed read ──
GPS = "get_positions__strict"
S("pos_strict_ok", GPS, [KEY, SEC, "BTC-USDT-SWAP", False], routes=[R("GET", "/v5/position/list", positions())])
S("pos_strict_empty", GPS, [KEY, SEC, "", False], routes=[R("GET", "/v5/position/list", {"retCode": 0, "retMsg": "OK", "result": {"list": []}})])
S("pos_strict_auth_wire", GPS, [KEY, SEC, "", False], routes=[R("GET", "/v5/position/list", err(10003, "API key is invalid."))])
S("pos_strict_symbol_invalid_wire", GPS, [KEY, SEC, "XYZ-USDT-SWAP", False],
  routes=[R("GET", "/v5/position/list", err(10001, "params error: symbol invalid"))])
S("pos_strict_timeout_wire", GPS, [KEY, SEC, "", False],
  routes=[R("GET", "/v5/position/list", {"raise": "timeout", "message": "HTTPSConnectionPool(host='api.bybit.com', port=443): Read timed out. (read timeout=10)"})],
  random=[0.25])
S("pos_strict_retcode_session", GPS, [KEY, SEC, "", False], routes=[SC("get_positions", err(10002, "invalid request, please check your server timestamp"))],
  mode="session")
S("pos_strict_list_null_session", GPS, [KEY, SEC, "", False], routes=[SC("get_positions", {"retCode": 0, "retMsg": "OK", "result": {"list": None}})],
  mode="session")
S("pos_strict_result_not_dict_session", GPS, [KEY, SEC, "", False], routes=[SC("get_positions", {"retCode": 0, "retMsg": "OK", "result": "x"})],
  mode="session")
S("pos_nonstrict_list_null_session", "get_positions", [KEY, SEC, "", False],
  routes=[SC("get_positions", {"retCode": 0, "retMsg": "OK", "result": {"list": None}})], mode="session")
S("pos_nonstrict_retcode_session", "get_positions", [KEY, SEC, "", False], routes=[SC("get_positions", err(10002, "bad ts"))], mode="session")

# ── [BYBIT-DELIST-TTL 2026-10] auto-blacklist count lives 24 h from the last failure, reset on success ──
_H = 3600.0
S("delist_ttl_seq", "__seq__", [
    ["record_symbol_failure", ["BTC-USDT-SWAP"], {}, 0.0],
    ["record_symbol_failure", ["BTCUSDT"], {}, 10.0],
    ["is_delisted", ["BTCUSDT"], {}, 0.0],
    ["record_symbol_failure", ["BTC-USDT-SWAP"], {}, 23 * _H],
    ["is_delisted", ["BTCUSDT"], {}, 0.0],
    ["is_delisted", ["BTC-USDT-SWAP"], {}, 0.0],          # raw-symbol lookup: the count is keyed by the Bybit symbol
    ["is_delisted", ["BTCUSDT"], {}, 24 * _H - 1.0],
    ["is_delisted", ["BTCUSDT"], {}, 1.0],                 # 24 h after the last failure → reset
    ["record_symbol_failure", ["BTCUSDT"], {}, 0.0],       # starts again at 1
    ["record_symbol_failure", ["BTCUSDT"], {}, 25 * _H],   # the previous one expired → 1 again
    ["record_symbol_failure", ["BTCUSDT"], {}, 1.0],
    ["record_symbol_failure", ["BTCUSDT"], {}, 1.0],
    ["is_delisted", ["BTCUSDT"], {}, 0.0],
    ["record_symbol_success", ["BTC-USDT-SWAP"], {}, 1.0],
    ["is_delisted", ["BTCUSDT"], {}, 0.0],
    ["record_symbol_failure", ["ETH-USDT-SWAP"], {}, 0.0],
])
# a successful entry resets the count (place_trade answers ok with an order id)
S("delist_ttl_reset_by_place_trade", "__seq__", [
    ["record_symbol_failure", ["BTC-USDT-SWAP"], {}, 0.0],
    ["record_symbol_failure", ["BTC-USDT-SWAP"], {}, 0.0],
    ["place_trade", LONG_ARGS, {"tp2": 89500.0, "trade_id": "tr-ttl", "user_id": 1}, 0.0],
    ["record_symbol_failure", ["BTC-USDT-SWAP"], {}, 0.0],
    ["is_delisted", ["BTCUSDT"], {}, 0.0],
], {}, SESSION_BASE + [SC("place_order", order_ok("ttl-1")), SC("get_positions", positions())], mode="session")
