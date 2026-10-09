"""OKX v5 replay scenarios (see harness.py for the format).

Shapes follow the v5 docs: {"code": "0", "msg": "", "data": [...]}; order errors carry
"code": "1" with the per-order sCode/sMsg inside data; some errors come with "data": [].
"""

KEY, SEC, PP = "OKKEY-abc123", "ok-secret-456", "Pass-phrase#1"


def ok(*data):
    return {"code": "0", "msg": "", "data": list(data)}


def err(code, msg, data=None):
    return {"code": code, "msg": msg, "data": data if data is not None else []}


def inst(inst_id="BTC-USDT-SWAP", lot="0.01", tick="0.1", lever="125", ct="0.01"):
    d = {"instType": "SWAP", "instId": inst_id, "ctType": "linear", "ctValCcy": inst_id.split("-")[0],
         "lotSz": lot, "tickSz": tick, "lever": lever, "minSz": lot, "state": "live"}
    if ct is not None:
        d["ctVal"] = ct
    return ok(d)


BAL = ok({"totalEq": "1000.5", "upl": "1.25", "details": [
    {"ccy": "BTC", "eq": "0.1", "cashBal": "0.1", "availBal": "0.1"},
    {"ccy": "USDT", "eq": "990.5", "cashBal": "980", "availBal": "900.1"}]})
LEV_OK = ok({"instId": "BTC-USDT-SWAP", "lever": "10", "mgnMode": "cross", "posSide": ""})
ORDER_OK = ok({"ordId": "312269865356374016", "clOrdId": "", "tag": "", "sCode": "0", "sMsg": "Order placed"})
ATTACH_ERR = err("1", "Operation failed.", [{"ordId": "", "clOrdId": "", "sCode": "51000", "sMsg": "Parameter attachAlgoOrds error"}])


def algo_ok(aid="681096944655273984"):
    return ok({"algoId": aid, "sCode": "0", "sMsg": ""})


ALGO_ERR = err("1", "Operation failed.", [{"algoId": "", "sCode": "51277", "sMsg": "TP trigger price cannot be higher than the last price"}])


def pos(inst_id="BTC-USDT-SWAP", p="1", side="long"):
    return ok({"instId": inst_id, "posSide": side, "pos": p, "avgPx": "87000.5", "markPx": "87010.1", "upl": "0.1",
               "lever": "10", "liqPx": "70000"})


def R(method, path, *resps, query=None):
    def spec(x):
        if isinstance(x, dict) and ("raise" in x or "json" in x or "text" in x or isinstance(x.get("status"), int)):
            return x
        return {"json": x}
    r = {"method": method, "path": path, "responses": [spec(x) for x in resps]}
    if query:
        r["query"] = query
    return r


SCENARIOS = []


def S(name, call, args, kwargs=None, routes=None, state=None, random=None, clock=1767225600.0):
    SCENARIOS.append({"name": name, "exchange": "okx", "call": call, "args": args, "kwargs": kwargs or {},
                      "routes": routes or [], "state": state or {}, "random": random or [], "clock": clock})


I = R("GET", "/api/v5/public/instruments", inst())
B = R("GET", "/api/v5/account/balance", BAL)
L = R("POST", "/api/v5/account/set-leverage", LEV_OK)
O = "/api/v5/trade/order"
A = "/api/v5/trade/order-algo"
PT = "place_trade"
LONG = [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86000.0, 88500.0, 5.0, 10]
SHORT = [KEY, SEC, "BTCUSDT", "SHORT", 87000.5, 88000.0, 85500.0, 5.0, 10]
LADDER = {"tp2": 89500.0, "tp3": 90500.0, "trade_id": "okx-trade-12345", "user_id": 42, "passphrase": PP}
CLEAN = [R("GET", "/api/v5/trade/orders-pending", ok()), R("GET", "/api/v5/trade/orders-algo-pending", ok())]

# ── atomic attachAlgoOrds ─────────────────────────────────────────────────────
S("pt_atomic_ok_ladder", PT, LONG, LADDER, [I, B, L, R("POST", O, ORDER_OK), R("POST", A, algo_ok("a2"), algo_ok("a3"))],
  state={"okx_offset_ms": 1234}, clock=1767225600.4567)
S("pt_atomic_ok_single_tp_time_id", PT, LONG, {"passphrase": PP}, [I, B, L, R("POST", O, ORDER_OK)], clock=1767225600.25)
S("pt_atomic_ok_short_tp2_only", PT, SHORT, {"tp2": 84500.0, "passphrase": PP, "trade_id": 987654321012},
  [I, B, L, R("POST", O, ORDER_OK), R("POST", A, algo_ok())])
S("pt_atomic_tp_partial_fail", PT, LONG, LADDER,
  [I, B, L, R("POST", O, ORDER_OK), R("POST", A, ALGO_ERR, ALGO_ERR, ALGO_ERR, algo_ok())])
S("pt_doge_ctval_contracts", PT, [KEY, SEC, "DOGE-USDT-SWAP", "LONG", 0.18234, 0.17851, 0.19111, 2.0, 20],
  {"tp2": 0.2, "tp3": 0.21, "passphrase": PP},
  [R("GET", "/api/v5/public/instruments", inst("DOGE-USDT-SWAP", "1", "0.00001", "75", "1000")), B, L,
   R("POST", O, ORDER_OK), R("POST", A, algo_ok())])
S("pt_max_lev_cap_and_bad_ctval", PT, [KEY, SEC, "ETH-USDT-SWAP", "LONG", 3000.0, 2950.0, 3100.0, 1.0, 50],
  {"passphrase": PP},
  [R("GET", "/api/v5/public/instruments", inst("ETH-USDT-SWAP", "0.1", "0.01", "20", "abc")), B, L, R("POST", O, ORDER_OK)])
S("pt_no_ctval_field", PT, [KEY, SEC, "ETH-USDT-SWAP", "LONG", 3000.0, 2950.0, 3100.0, 1.0, 5], {},
  [R("GET", "/api/v5/public/instruments", inst("ETH-USDT-SWAP", "0.1", "0.01", "20", None)), B, L, R("POST", O, ORDER_OK)])

# ── [OKX-LOT-CONTRACTS 2026-10] size in contracts (lotSz / minSz are contracts) ──
def bal(eq):
    return ok({"totalEq": eq, "upl": "0", "details": [{"ccy": "USDT", "eq": eq, "cashBal": eq, "availBal": eq}]})


BTC_I = R("GET", "/api/v5/public/instruments", inst("BTC-USDT-SWAP", "0.01", "0.1", "100", "0.01"))
DOGE_I = R("GET", "/api/v5/public/instruments", inst("DOGE-USDT-SWAP", "1", "0.00001", "75", "1000"))
S("pt_lot_btc_fractional_ladder", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 100000.0, 98000.0, 104000.0, 1.0, 10],
  {"tp2": 106000.0, "tp3": 108000.0, "passphrase": PP},
  [BTC_I, R("GET", "/api/v5/account/balance", bal("3000")), L, R("POST", O, ORDER_OK), R("POST", A, algo_ok("a2"), algo_ok("a3"))])
S("pt_lot_btc_small_account_quarter_contract", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 100000.0, 98000.0, 104000.0, 1.0, 10],
  {"passphrase": PP}, [BTC_I, R("GET", "/api/v5/account/balance", bal("500")), L, R("POST", O, ORDER_OK)])
S("pt_lot_doge_below_min_skip", PT, [KEY, SEC, "DOGE-USDT-SWAP", "LONG", 0.1, 0.098, 0.104, 1.0, 10],
  {"passphrase": PP}, [DOGE_I, R("GET", "/api/v5/account/balance", bal("100")), L])
S("pt_lot_doge_below_min_opt_in", PT, [KEY, SEC, "DOGE-USDT-SWAP", "LONG", 0.1, 0.098, 0.104, 1.0, 10],
  {"passphrase": PP, "allow_low_notional_boost": True},
  [DOGE_I, R("GET", "/api/v5/account/balance", bal("100")), L, R("POST", O, ORDER_OK)])
S("pt_lot_min_sz_above_lot_leg_to_tp1", PT, [KEY, SEC, "ETH-USDT-SWAP", "LONG", 3000.0, 2970.0, 3060.0, 1.0, 10],
  {"tp2": 3090.0, "tp3": 3120.0, "passphrase": PP},
  [R("GET", "/api/v5/public/instruments", ok({"instType": "SWAP", "instId": "ETH-USDT-SWAP", "ctType": "linear", "ctValCcy": "ETH",
                                               "lotSz": "0.01", "tickSz": "0.01", "lever": "100", "minSz": "0.05", "state": "live",
                                               "ctVal": "0.1"})),
   R("GET", "/api/v5/account/balance", bal("50")), L, R("POST", O, ORDER_OK), R("POST", A, algo_ok("a2"))])
S("pt_lot_bad_min_sz", PT, [KEY, SEC, "ETH-USDT-SWAP", "LONG", 3000.0, 2970.0, 3060.0, 1.0, 10], {"passphrase": PP},
  [R("GET", "/api/v5/public/instruments", ok({"instId": "ETH-USDT-SWAP", "lotSz": "0.01", "tickSz": "0.01", "lever": "100",
                                               "minSz": "n/a", "ctVal": "0.1"})),
   R("GET", "/api/v5/account/balance", bal("1000")), L, R("POST", O, ORDER_OK)])
S("close_partial_float_noise", "close_position_partial", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.0029, PP], {},
  [BTC_I, R("POST", O, ORDER_OK)])
S("sltp_tiny_position_tp_legs_below_lot", "place_sl_tp_for_position",
  [KEY, SEC, "DOGE-USDT-SWAP", "LONG", 1500.0, 0.17851, 0.19111, 0.2, 0.21, PP], {},
  [DOGE_I, R("GET", "/api/v5/trade/orders-algo-pending", ok()), R("POST", A, algo_ok("sl"), algo_ok("t1"))])

# ── fallback / legacy ────────────────────────────────────────────────────────
S("pt_fallback_sMsg_legacy_full", PT, LONG, LADDER,
  [I, B, L, R("POST", O, ATTACH_ERR, ORDER_OK), R("POST", A, algo_ok("sl"), algo_ok("t1"), algo_ok("t2"), algo_ok("t3"))])
S("pt_fallback_51001_legacy_error", PT, LONG, {"passphrase": PP},
  [I, B, L, R("POST", O, err("51001", "Instrument ID does not exist", [{"sCode": "51001", "sMsg": "Instrument ID does not exist"}]),
               err("1", "Operation failed.", [{"ordId": "", "sCode": "51008", "sMsg": "Order failed. Insufficient USDT margin (51008)"}]))])
S("pt_fallback_51000_empty_data_crash", PT, LONG, {"passphrase": PP},
  [I, B, L, R("POST", O, err("51000", "Parameter attachAlgoOrds error"))])
S("pt_real_error_no_fallback", PT, LONG, {"passphrase": PP},
  [I, B, L, R("POST", O, err("1", "Operation failed.", [{"ordId": "", "sCode": "51131", "sMsg": "Insufficient balance"}]))])
S("pt_real_error_code_in_msg", PT, LONG, {"passphrase": PP},
  [I, B, L, R("POST", O, err("1", "Operation failed.", [{"ordId": "", "sCode": "51004", "sMsg": ""}]))])
S("pt_sl_fail_safety_close_ok", PT, LONG, LADDER,
  [I, B, L, R("POST", O, ATTACH_ERR, ORDER_OK), R("POST", A, ALGO_ERR, ALGO_ERR, ALGO_ERR, algo_ok()),
   R("GET", "/api/v5/account/positions", pos(p="1")), R("POST", "/api/v5/trade/close-position", ok({"instId": "BTC-USDT-SWAP", "posSide": "long"})),
   R("GET", "/api/v5/trade/orders-pending", ok({"ordId": "9", "instId": "BTC-USDT-SWAP", "side": "buy", "ordType": "limit"},
                                              {"ordId": "10", "instId": "ETH-USDT-SWAP", "side": "buy", "ordType": "limit"})),
   R("POST", "/api/v5/trade/cancel-order", ok({"ordId": "9", "sCode": "0", "sMsg": ""})),
   R("GET", "/api/v5/trade/orders-algo-pending", ok({"algoId": "x1"}, {"algoId": ""}, {"algoId": "x2"})),
   R("POST", "/api/v5/trade/cancel-algos", ok())])
S("pt_sl_fail_safety_close_fail", PT, LONG, {"passphrase": PP},
  [I, B, L, R("POST", O, ATTACH_ERR, ORDER_OK), R("POST", A, ALGO_ERR, ALGO_ERR, ALGO_ERR, algo_ok()),
   R("GET", "/api/v5/account/positions", pos(p="-2", side="net")),
   R("POST", "/api/v5/trade/close-position", err("51023", "Position does not exist")), *CLEAN])
S("pt_sl_fail_no_position", PT, LONG, {"passphrase": PP},
  [I, B, L, R("POST", O, ATTACH_ERR, ORDER_OK), R("POST", A, ALGO_ERR, ALGO_ERR, ALGO_ERR, ALGO_ERR, ALGO_ERR, ALGO_ERR),
   R("GET", "/api/v5/account/positions", ok())])
S("pt_sl_fail_positions_raise", PT, LONG, {"passphrase": PP},
  [I, B, L, R("POST", O, ATTACH_ERR, ORDER_OK), R("POST", A, ALGO_ERR, ALGO_ERR, ALGO_ERR, algo_ok()),
   R("GET", "/api/v5/account/positions", {"status": 200, "text": ""})])

# ── pre-trade failures ───────────────────────────────────────────────────────
S("pt_instrument_not_found", PT, LONG, {}, [R("GET", "/api/v5/public/instruments", ok())])
S("pt_instrument_html", PT, LONG, {}, [R("GET", "/api/v5/public/instruments", {"status": 502, "text": "<html>bad gateway</html>", "headers": {"Content-Type": "text/html"}})])
S("pt_zero_balance_empty_data", PT, LONG, {"passphrase": "bad"}, [I, R("GET", "/api/v5/account/balance", err("50111", "Invalid OK-ACCESS-KEY"))])
S("pt_balance_details_fallback", PT, LONG, {"passphrase": PP},
  [I, R("GET", "/api/v5/account/balance", ok({"totalEq": "", "details": [{"ccy": "USDT", "eq": "", "cashBal": "500.25", "availBal": "1"}]})), L,
   R("POST", O, ORDER_OK)])
S("pt_leverage_failed", PT, LONG, {"passphrase": PP},
  [I, B, R("POST", "/api/v5/account/set-leverage", err("59102", "Leverage exceeds the maximum leverage")), R("POST", O, ORDER_OK)])
S("pt_leverage_none_body", PT, LONG, {"passphrase": PP},
  [I, B, R("POST", "/api/v5/account/set-leverage", {"status": 200, "text": " "}), R("POST", O, ORDER_OK)])
S("pt_sl_equals_entry", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 87000.5, 88500.0, 1.0, 10], {}, [I, B, L])
S("pt_low_notional_skip", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86000.0, 88500.0, 0.05, 10], {},
  [I, R("GET", "/api/v5/account/balance", ok({"totalEq": "100"})), L])
S("pt_low_notional_boost", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 87000.5, 86000.0, 88500.0, 0.05, 10],
  {"allow_low_notional_boost": True}, [I, R("GET", "/api/v5/account/balance", ok({"totalEq": "100"})), L, R("POST", O, ORDER_OK)])
S("pt_low_notional_boost_too_small", PT, [KEY, SEC, "BTC-USDT-SWAP", "LONG", 1870000.5, 1860000.0, 1885000.0, 0.001, 10],
  {"allow_low_notional_boost": True}, [I, R("GET", "/api/v5/account/balance", ok({"totalEq": "100"})), L])
S("pt_margin_mode", PT, LONG, {"risk_mode": "margin", "tp2": 89000.0}, [I, B, L, R("POST", O, ORDER_OK), R("POST", A, algo_ok())])
S("pt_notional_mode_tp3_without_tp2", PT, LONG, {"risk_mode": "notional", "tp3": 91000.0}, [I, B, L, R("POST", O, ORDER_OK)])
S("pt_entry_timeout", PT, LONG, {"passphrase": PP}, [I, B, L, R("POST", O, {"raise": "timeout"}),
                                                      R("GET", O, {"raise": "timeout"})])
# ── [OKX-ENTRY-TIMEOUT 2026-10] a lost entry answer is resolved by clOrdId ──
FOUND = ok({"ordId": "o-77", "clOrdId": "eokxtrade12345", "state": "filled", "accFillSz": "0.58"})
FOUND_ATT = ok({"ordId": "o-90", "clOrdId": "eokxtrade12345", "state": "filled", "accFillSz": "0.58",
               "attachAlgoOrds": [{"attachAlgoClOrdId": "slokxtrade12345", "slTriggerPx": "86000.0"},
                                  {"attachAlgoClOrdId": "tp1okxtrade12345", "tpTriggerPx": "88500.0"}]})
S("pt_entry_lost_found_attached_sl", PT, LONG, LADDER,
  [I, B, L, R("POST", O, {"raise": "timeout"}), R("GET", O, err("51603", "Order does not exist"), FOUND_ATT),
   R("POST", A, algo_ok("a2"), algo_ok("a3"))])
S("pt_entry_lost_found_ladder", PT, LONG, LADDER,
  [I, B, L, R("POST", O, {"raise": "timeout"}), R("GET", O, FOUND), R("POST", A, algo_ok("a2"), algo_ok("a3"))])
S("pt_entry_lost_absent", PT, LONG, LADDER,
  [I, B, L, R("POST", O, {"raise": "timeout"}), R("GET", O, err("51603", "Order does not exist"))])
S("pt_entry_lost_canceled_unfilled", PT, LONG, LADDER,
  [I, B, L, R("POST", O, {"raise": "connect", "message": "Server disconnected"}),
   R("GET", O, ok({"ordId": "o-78", "state": "canceled", "accFillSz": "0"}))])
S("pt_entry_lost_query_flaky_then_found", PT, LONG, LADDER,
  [I, B, L, R("POST", O, {"raise": "timeout"}), R("GET", O, {"raise": "timeout"}, err("50011", "Too Many Requests"), FOUND),
   R("POST", A, algo_ok("a2"), algo_ok("a3"))])
S("pt_entry_lost_unknown_raises", PT, LONG, LADDER,
  [I, B, L, R("POST", O, {"raise": "timeout"}), R("GET", O, {"raise": "timeout"}, ok(), {"status": 502, "text": "<html>502</html>",
                                                                                       "headers": {"Content-Type": "text/html"}})])
S("pt_entry_dup_clordid_scode", PT, LONG, LADDER,
  [I, B, L, R("POST", O, err("1", "Operation failed.", [{"ordId": "", "clOrdId": "eokxtrade12345", "sCode": "51016",
                                                        "sMsg": "Duplicated clOrdId"}])),
   R("GET", O, FOUND), R("POST", A, algo_ok("a2"), algo_ok("a3"))])
S("pt_entry_dup_clordid_top_code_absent", PT, LONG, {"passphrase": PP},
  [I, B, L, R("POST", O, err("51016", "Duplicated clOrdId")), R("GET", O, err("51603", "Order does not exist"))])
S("pt_entry_other_refusal_not_looked_up", PT, LONG, {"passphrase": PP},
  [I, B, L, R("POST", O, err("1", "Operation failed.", [{"ordId": "", "sCode": "51008", "sMsg": "Insufficient USDT margin"}]))])
S("pt_legacy_entry_lost_found", PT, LONG, LADDER,
  [I, B, L, R("POST", O, ATTACH_ERR, {"raise": "timeout"}), R("GET", O, FOUND),
   R("POST", A, algo_ok("sl"), algo_ok("t1"), algo_ok("t2"), algo_ok("t3"))])
S("pt_long_trade_id_hashed_client_ids", PT, LONG, {"passphrase": PP, "trade_id": "user-123456789_signal-987654321_extra-long"},
  [I, B, L, R("POST", O, ORDER_OK)])
S("pt_entry_connect_redacted", PT, LONG, {"passphrase": PP},
  [I, B, L, R("POST", O, {"raise": "connect", "message": "Cannot connect to host www.okx.com:443 ssl:default [Pass-phrase#1 leaked]"})])
S("pt_entry_html", PT, LONG, {"passphrase": PP}, [I, B, L, R("POST", O, {"status": 502, "text": "<html>502</html>", "headers": {"Content-Type": "text/html"}})])
S("pt_killswitch", PT, LONG, {}, [], state={"ks_halted": "HALTED"})
S("pt_plan_deny", PT, LONG, {"user_id": 5}, [], state={"plan_deny": {"ok": False, "order_id": "", "error": "plan_denied"}})

# ── reads ────────────────────────────────────────────────────────────────────
S("get_balance_total_eq", "get_balance", [KEY, SEC, PP], {}, [B])
S("get_balance_cashbal", "get_balance", [KEY, SEC, PP], {},
  [R("GET", "/api/v5/account/balance", ok({"totalEq": "0", "details": [{"ccy": "USDT", "eq": "", "cashBal": "12.5"}]}))])
S("get_balance_bad_eq", "get_balance", [KEY, SEC, PP], {},
  [R("GET", "/api/v5/account/balance", ok({"totalEq": "x", "details": [{"ccy": "USDT", "eq": "bad"}]}))])
S("get_balance_no_usdt", "get_balance", [KEY, SEC, PP], {}, [R("GET", "/api/v5/account/balance", ok({"details": [{"ccy": "BTC", "eq": "1"}]}))])
S("get_balance_timeout", "get_balance", [KEY, SEC, PP], {}, [R("GET", "/api/v5/account/balance", {"raise": "timeout"})])
S("get_last_price_ok", "get_last_price", [KEY, SEC, "ETHUSDT"], {}, [R("GET", "/api/v5/market/ticker", ok({"instId": "ETH-USDT-SWAP", "last": "3001.25"}))])
S("get_last_price_err", "get_last_price", [KEY, SEC, "ETHUSDT"], {}, [R("GET", "/api/v5/market/ticker", err("51001", "Instrument ID does not exist"))])
S("test_connection_ok", "test_connection", [KEY, SEC, PP], {}, [B])
S("test_connection_negative", "test_connection", [KEY, SEC, PP], {},
  [R("GET", "/api/v5/account/balance", ok({"details": [{"ccy": "USDT", "eq": "-5.5"}]}))])
S("test_connection_raises", "test_connection", [KEY, SEC, PP], {}, [R("GET", "/api/v5/account/balance", {"code": "0", "data": [["odd"]]})])
S("get_positions_ctval", "get_positions", [KEY, SEC, "DOGE-USDT-SWAP", PP], {},
  [R("GET", "/api/v5/account/positions", ok({"instId": "DOGE-USDT-SWAP", "posSide": "short", "pos": "-3", "avgPx": "0.18",
                                             "markPx": "", "upl": None, "lever": "20", "liqPx": "0.3"},
                                            {"instId": "DOGE-USDT-SWAP", "posSide": "long", "pos": "0"})),
   R("GET", "/api/v5/public/instruments", inst("DOGE-USDT-SWAP", "1", "0.00001", "75", "1000"))])
S("get_positions_all_unknown_inst", "get_positions", [KEY, SEC], {},
  [R("GET", "/api/v5/account/positions", ok({"posSide": "long", "pos": "2"})), R("GET", "/api/v5/public/instruments", ok())])
S("get_positions_none_body", "get_positions", [KEY, SEC, None, PP], {}, [R("GET", "/api/v5/account/positions", {"status": 200, "text": ""})])
S("get_open_orders", "get_open_orders", [KEY, SEC, PP], {},
  [R("GET", "/api/v5/trade/orders-pending", ok({"ordId": "1", "instId": "BTC-USDT-SWAP", "side": "buy", "ordType": "limit"}, {}))])
S("get_closed_pnl", "get_closed_pnl", [KEY, SEC, "BTC-USDT-SWAP", PP], {},
  [R("GET", "/api/v5/account/positions-history", ok(
      {"direction": "long", "posSide": "net", "uTime": "1767225000000", "closeAvgPx": "87500", "openAvgPx": "87000", "closeTotalPos": "1", "realizedPnl": "5.2", "clOrdId": "abc"},
      {"direction": "", "posSide": "SHORT", "uTime": "1767225100000", "closeAvgPx": "86000", "openAvgPx": "86500", "closeTotalPos": "2", "realizedPnl": "-1.5"},
      {"direction": "net", "closeAvgPx": "1"},
      {"direction": "long", "closeAvgPx": "0"},
      {"direction": "short", "closeAvgPx": "bad"},
      {"direction": None, "posSide": "long", "closeAvgPx": "2"}))])
S("get_closed_pnl_error", "get_closed_pnl", [KEY, SEC, "BTC-USDT-SWAP", PP], {}, [R("GET", "/api/v5/account/positions-history", {"status": 200, "text": "[1]"})])
S("get_account_summary", "get_account_summary", [KEY, SEC, PP], {}, [B])
S("get_account_summary_bad", "get_account_summary", [KEY, SEC, PP], {}, [R("GET", "/api/v5/account/balance", ok({"totalEq": ""}))])
S("get_dashboard_quirk", "get_dashboard", [KEY, SEC, PP], {}, [B, R("GET", "/api/v5/account/positions", pos())])

# ── order management ─────────────────────────────────────────────────────────
S("cancel_order_ok", "cancel_order", [KEY, SEC, "BTC-USDT-SWAP", "123", PP], {}, [R("POST", "/api/v5/trade/cancel-order", ok({"ordId": "123", "sCode": "0"}))])
S("cancel_order_retry", "cancel_order", [KEY, SEC, "BTC-USDT-SWAP", "123", PP], {},
  [R("POST", "/api/v5/trade/cancel-order", {"raise": "timeout"}, err("50013", "Systems are busy. Please try again later."), ok())],
  random=[0.2, 0.8])
S("cancel_order_final_error", "cancel_order", [KEY, SEC, "BTC-USDT-SWAP", "123", PP], {},
  [R("POST", "/api/v5/trade/cancel-order", err("51400", "Order cancellation failed as the order has been filled"))])
S("cancel_all_full", "cancel_all_orders", [KEY, SEC, "BTCUSDT", PP], {},
  [R("GET", "/api/v5/trade/orders-pending", ok({"ordId": "1", "instId": "BTC-USDT-SWAP"}, {"ordId": "2", "instId": "BTC-USDT-SWAP"}, {"ordId": "3", "instId": "ETH-USDT-SWAP"})),
   R("POST", "/api/v5/trade/cancel-order", ok(), err("51400", "filled")),
   R("GET", "/api/v5/trade/orders-algo-pending", ok({"algoId": "a"}, {"algoId": "b"})),
   R("POST", "/api/v5/trade/cancel-algos", err("1", "partial"))])
S("cancel_all_algo_error", "cancel_all_orders", [KEY, SEC, "BTCUSDT", PP], {},
  [R("GET", "/api/v5/trade/orders-pending", ok()), R("GET", "/api/v5/trade/orders-algo-pending", {"status": 200, "text": ""})])
S("close_position_ok", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", PP], {},
  [R("POST", "/api/v5/trade/close-position", ok({"instId": "BTC-USDT-SWAP"})), *CLEAN])
S("close_position_fail_cleanup_raises", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "short", PP], {},
  [R("POST", "/api/v5/trade/close-position", err("51023", "Position does not exist")),
   R("GET", "/api/v5/trade/orders-pending", {"status": 200, "text": ""})])
# [OKX-CLOSE-CLEANUP 2026-10] / [QC-SIDE-FIX 2026-10]
S("close_position_fail_position_gone", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", PP], {},
  [R("POST", "/api/v5/trade/close-position", err("51023", "Position does not exist")),
   R("GET", "/api/v5/account/positions", ok()), *CLEAN])
S("close_position_fail_position_alive", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", PP], {},
  [R("POST", "/api/v5/trade/close-position", err("50001", "Service temporarily unavailable")),
   R("GET", "/api/v5/account/positions", pos())])
S("close_position_fail_positions_unknown", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "SHORT", PP], {},
  [R("POST", "/api/v5/trade/close-position", {"raise": "timeout"}),
   R("GET", "/api/v5/account/positions", err("50011", "Too Many Requests"))])
S("close_position_buy_alias_hedge_other_side_alive", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "Buy", PP], {},
  [R("POST", "/api/v5/trade/close-position", ok({"instId": "BTC-USDT-SWAP", "posSide": "long"})),
   R("GET", "/api/v5/account/positions", pos(p="2", side="short")),
   R("GET", "/api/v5/trade/orders-pending", ok({"ordId": "7", "posSide": "long"}, {"ordId": "8", "posSide": "short"}, {"ordId": "", "posSide": "long"})),
   R("POST", "/api/v5/trade/cancel-order", ok({"ordId": "7", "sCode": "0", "sMsg": ""})),
   R("GET", "/api/v5/trade/orders-algo-pending", ok({"algoId": "a-long", "posSide": "long"}, {"algoId": "a-short", "posSide": "short"}, {"algoId": "a-net", "posSide": "net"})),
   R("POST", "/api/v5/trade/cancel-algos", ok())])
S("close_position_hedge_no_long_leftovers", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "sell", PP], {},
  [R("POST", "/api/v5/trade/close-position", ok({"instId": "BTC-USDT-SWAP", "posSide": "short"})),
   R("GET", "/api/v5/account/positions", pos()),
   R("GET", "/api/v5/trade/orders-pending", err("50011", "Too Many Requests")),
   R("GET", "/api/v5/trade/orders-algo-pending", ok({"algoId": "a-long", "posSide": "long"}))])
S("close_position_unknown_direction", "close_position", [KEY, SEC, "BTC-USDT-SWAP", "FLAT", PP], {}, [])
S("close_position_none_direction", "close_position", [KEY, SEC, "BTC-USDT-SWAP", None, PP], {}, [])
S("close_partial_long_ok", "close_position_partial", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.015, PP], {},
  [I, R("POST", "/api/v5/trade/order", ORDER_OK)])
S("close_partial_short_lower_case", "close_position_partial", [KEY, SEC, "ETH-USDT-SWAP", " short ", 0.37, PP], {},
  [R("GET", "/api/v5/public/instruments", inst("ETH-USDT-SWAP", "0.1", "0.01", "100", "0.1")), R("POST", "/api/v5/trade/order", ORDER_OK)])
S("close_partial_below_lot", "close_position_partial", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.00005, PP], {}, [I])
S("close_partial_rejected", "close_position_partial", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.02, PP], {},
  [I, R("POST", "/api/v5/trade/order", err("1", "Operation failed.", [{"ordId": "", "sCode": "51169", "sMsg": "Order failed because you don't have any positions in this direction"}]))])
S("close_partial_rejected_no_data", "close_position_partial", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.02, PP], {},
  [I, R("POST", "/api/v5/trade/order", err("50113", "Invalid Sign"))])
S("close_partial_unknown_direction", "close_position_partial", [KEY, SEC, "BTC-USDT-SWAP", "Buy", 0.02, PP], {}, [])
S("trail_ok", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 86500.07, "LONG", 0, PP], {}, [I, R("POST", A, algo_ok())])
S("trail_err", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 88500.04, "SHORT", 0, PP], {}, [I, R("POST", A, ALGO_ERR)])
S("breakeven", "set_breakeven", [KEY, SEC, "BTC-USDT-SWAP", 87000.5, "LONG", 0, PP], {}, [I, R("POST", A, algo_ok())])
S("sltp_full", "place_sl_tp_for_position", [KEY, SEC, "DOGE-USDT-SWAP", "LONG", 12345.0, 0.17851, 0.19111, 0.2, 0.21, PP], {},
  [R("GET", "/api/v5/public/instruments", inst("DOGE-USDT-SWAP", "1", "0.00001", "75", "1000")),
   R("GET", "/api/v5/trade/orders-algo-pending", ok({"algoId": "old1"}, {"algoId": None})),
   R("POST", "/api/v5/trade/cancel-algos", ok()),
   R("POST", A, algo_ok("sl"), algo_ok("t1"), algo_ok("t2"), algo_ok("t3"))])
S("sltp_failures", "place_sl_tp_for_position", [KEY, SEC, "BTC-USDT-SWAP", "short", 0.5, 88000.0, 85500.0, 84500.0, 0.0, PP], {},
  [I, R("GET", "/api/v5/trade/orders-algo-pending", err("50001", "x")),
   R("POST", A, ALGO_ERR, ALGO_ERR, ALGO_ERR, algo_ok(), ALGO_ERR, ALGO_ERR, ALGO_ERR)])
S("sltp_no_tp", "place_sl_tp_for_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.5, 86000.0, 0.0], {},
  [I, R("GET", "/api/v5/trade/orders-algo-pending", ok()), R("POST", A, algo_ok())])
# ── [OKX-SLTP-REPLACE 2026-10] old SL off only after the new one, other side untouched ──
PENDING_MIX = ok({"algoId": "old-sl", "posSide": "long", "slTriggerPx": "85000", "tpTriggerPx": ""},
                 {"algoId": "old-tp", "posSide": "long", "slTriggerPx": "", "tpTriggerPx": "88000"},
                 {"algoId": "other-sl", "posSide": "short", "slTriggerPx": "90000", "tpTriggerPx": ""},
                 {"algoId": "net-tp", "posSide": "net", "slTriggerPx": None, "tpTriggerPx": "89000"},
                 {"algoId": "", "posSide": "long", "slTriggerPx": "1"})
S("sltp_replace_ok", "place_sl_tp_for_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.02, 86000.0, 88500.0, 89500.0, 0.0, PP], {},
  [I, R("GET", "/api/v5/trade/orders-algo-pending", PENDING_MIX), R("POST", "/api/v5/trade/cancel-algos", ok(), ok()),
   R("POST", A, algo_ok("new-sl"), algo_ok("t1"), algo_ok("t2"))])
S("sltp_replace_sl_refused_keeps_old", "place_sl_tp_for_position",
  [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.02, 86000.0, 88500.0, 0.0, 0.0, PP], {},
  [I, R("GET", "/api/v5/trade/orders-algo-pending", PENDING_MIX), R("POST", "/api/v5/trade/cancel-algos", ok()),
   R("POST", A, ALGO_ERR, ALGO_ERR, ALGO_ERR, algo_ok("t1"))])
S("sltp_replace_no_sl_no_tp", "place_sl_tp_for_position", [KEY, SEC, "BTC-USDT-SWAP", "short", 0.02, 0.0, 0.0], {},
  [I, R("GET", "/api/v5/trade/orders-algo-pending", PENDING_MIX)])
S("sltp_replace_cancel_raises", "place_sl_tp_for_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.02, 86000.0, 88500.0, 0.0, 0.0, PP], {},
  [I, R("GET", "/api/v5/trade/orders-algo-pending", PENDING_MIX), R("POST", "/api/v5/trade/cancel-algos", {"raise": "timeout"}),
   R("POST", A, algo_ok("new-sl"), algo_ok("t1"))])
FULL_SL = {"algoId": "full-sl", "posSide": "long", "slTriggerPx": "86000.0", "tpTriggerPx": "", "closeFraction": "1"}
S("sltp_full_sl_same_price_untouched", "place_sl_tp_for_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.02, 86000.0, 0.0], {},
  [I, R("GET", "/api/v5/trade/orders-algo-pending", ok(FULL_SL, {"algoId": "att-sl", "posSide": "long", "slTriggerPx": "86000",
                                                              "closeFraction": ""})),
   R("POST", "/api/v5/trade/cancel-algos", ok())])
S("sltp_full_sl_moved_by_amend", "place_sl_tp_for_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.02, 86500.0, 0.0], {},
  [I, R("GET", "/api/v5/trade/orders-algo-pending", ok(FULL_SL)), R("POST", "/api/v5/trade/amend-algos", ok({"algoId": "full-sl", "sCode": "0"}))])
S("sltp_full_sl_amend_refused", "place_sl_tp_for_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.02, 88500.0, 0.0], {},
  [I, R("GET", "/api/v5/trade/orders-algo-pending", ok(FULL_SL)),
   R("POST", "/api/v5/trade/amend-algos", err("1", "Operation failed.", [{"algoId": "full-sl", "sCode": "51280", "sMsg": "SL trigger price must be lower than the last price"}]))])
S("sltp_doge_one_lot_full_tp1", "place_sl_tp_for_position",
  [KEY, SEC, "DOGE-USDT-SWAP", "LONG", 1000.0, 0.17851, 0.19111, 0.2, 0.21, PP], {},
  [DOGE_I, R("GET", "/api/v5/trade/orders-algo-pending", ok({"algoId": "att-tp1", "posSide": "long", "tpTriggerPx": "0.19"})),
   R("POST", A, algo_ok("sl"), algo_ok("t1")), R("POST", "/api/v5/trade/cancel-algos", ok())])
S("sltp_doge_ten_lots_ladder", "place_sl_tp_for_position",
  [KEY, SEC, "DOGE-USDT-SWAP", "SHORT", 10000.0, 0.19111, 0.17851, 0.17, 0.16, PP], {},
  [DOGE_I, R("GET", "/api/v5/trade/orders-algo-pending", ok()), R("POST", A, algo_ok("sl"), algo_ok("t1"), ALGO_ERR, ALGO_ERR, ALGO_ERR,
                                                                     algo_ok("t3"))])
S("trail_moves_full_sl_by_amend", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 87100.04, "LONG", 0, PP], {},
  [I, R("GET", "/api/v5/trade/orders-algo-pending", ok(FULL_SL, {"algoId": "att-sl", "posSide": "long", "slTriggerPx": "86000"})),
   R("POST", "/api/v5/trade/amend-algos", ok({"algoId": "full-sl", "sCode": "0"})), R("POST", "/api/v5/trade/cancel-algos", ok())])
S("trail_new_full_sl_then_old_off", "set_breakeven", [KEY, SEC, "BTC-USDT-SWAP", 87000.5, "SHORT", 0, PP], {},
  [I, R("GET", "/api/v5/trade/orders-algo-pending", ok({"algoId": "att-sl", "posSide": "short", "slTriggerPx": "88000"},
                                                       {"algoId": "long-sl", "posSide": "long", "slTriggerPx": "86000"})),
   R("POST", A, algo_ok("be")), R("POST", "/api/v5/trade/cancel-algos", ok())])
S("trail_refused_keeps_old", "set_trailing_sl", [KEY, SEC, "BTC-USDT-SWAP", 87100.0, "LONG", 0, PP], {},
  [I, R("GET", "/api/v5/trade/orders-algo-pending", ok({"algoId": "att-sl", "posSide": "long", "slTriggerPx": "86000"})),
   R("POST", A, ALGO_ERR)])
S("algo_sl_orders_listing", "get_algo_sl_orders", [KEY, SEC, "BTCUSDT", PP], {},
  [R("GET", "/api/v5/trade/orders-algo-pending", ok({"algoId": "s1", "instId": "BTC-USDT-SWAP", "slTriggerPx": "86000", "posSide": "long",
                                                     "side": "sell"},
                                                    {"algoId": "t1", "instId": "BTC-USDT-SWAP", "slTriggerPx": "", "tpTriggerPx": "88000"},
                                                    {"algoId": "bad", "slTriggerPx": "n/a"}, {"algoId": "zero", "slTriggerPx": "0"}))])
S("algo_sl_orders_error", "get_algo_sl_orders", [KEY, SEC, "BTCUSDT", PP], {},
  [R("GET", "/api/v5/trade/orders-algo-pending", err("50001", "Service temporarily unavailable"))])
S("sltp_crash", "place_sl_tp_for_position", [KEY, SEC, "BTC-USDT-SWAP", "LONG", 0.5, 86000.0, 88000.0], {},
  [I, R("GET", "/api/v5/trade/orders-algo-pending", ok()), R("POST", A, {"status": 200, "text": ""})])

# ── time sync / helpers ──────────────────────────────────────────────────────
S("sync_time_ok", "sync_time", [], {}, [R("GET", "/api/v5/public/time", ok({"ts": "1767225601234"}))], clock=1767225600.5)
S("sync_time_bad_code", "sync_time", [], {}, [R("GET", "/api/v5/public/time", err("50001", "x"))], state={"okx_offset_ms": 77})
S("sync_time_text_plain", "sync_time", [], {}, [R("GET", "/api/v5/public/time", {"status": 200, "text": "{}", "headers": {"Content-Type": "text/plain"}})])
S("okx_sz_doge", "okx_sz", ["DOGEUSDT", 12345.0], {}, [R("GET", "/api/v5/public/instruments", inst("DOGE-USDT-SWAP", "1", "0.00001", "75", "1000"))])
S("okx_sz_unknown", "okx_sz", ["XYZ-USDT-SWAP", 1.5], {}, [R("GET", "/api/v5/public/instruments", ok())])
