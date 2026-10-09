"""fake_exchanges.py — stateful fake exchange servers for the wire-level auto-trade differential
(drive_wire_diff.py). Bybit v5, BingX swap v2, Binance USDⓈ-M and OKX v5 behind one `handle()`
the driver's fake HTTP layers (aiohttp sessions of the four traders, pybit's requests) call with the
request exactly as the bot built it.

Per account (exchange + API key): balance, leverage, position mode (Bybit one-way / hedge, Binance
dual-side, OKX long/short, BingX hedge), positions per native symbol and side, resting limit /
conditional / reduce-only orders, closed-PnL records. Requests are authenticated like the exchange
does it (key header, HMAC over the exchange's pre-image, OKX passphrase) — `sig_ok` is recorded.

Fills: market orders fill at the last price; a limit order fills when it is marketable (crosses the
last price), else it rests; conditional / take-profit orders rest; a reduce-only order needs a
position on the side it reduces (else the exchange's reduce-only error).

Faults (scenario `faults`, matched in order, counted per scenario):
  {ex, path, method?, nth: 1-based index among the matching requests | "all", kind, ...}
  kind "resp"         answer `json` (+ `status`, `headers`) without touching the state
  kind "hang_accept"  apply the request (the exchange accepted it), then the reply never comes:
                      the client's own timeout fires (aiohttp total / requests timeout)
  kind "hang"         the reply never comes, nothing applied
  kind "connect"      connection refused (aiohttp ClientConnectorError / requests ConnectionError)
  kind "status"       HTTP `status` with `text` (HTML 502, 429 …), nothing applied

Everything here is test scaffolding: the JS replay serves the recorded answers byte for byte, the
simulator itself is not mirrored on the site.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import urllib.parse

JSON_HDR = {"Content-Type": "application/json"}


def fmt(x, dp=10):
    s = f"{float(x):.{dp}f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s if s not in ("-0", "") else "0"


def resp(obj, status=200, headers=None):
    h = dict(JSON_HDR)
    h.update(headers or {})
    return {"status": status, "headers": h, "text": json.dumps(obj)}


def parse_qs(qs):
    out = {}
    if not qs:
        return out
    for part in qs.split("&"):
        if not part:
            continue
        k, _, v = part.partition("=")
        out[urllib.parse.unquote_plus(k)] = urllib.parse.unquote_plus(v)
    return out


class Account:
    def __init__(self, ex, key, secret, passphrase="", balance=1000.0, hedge=None, perms=None, avail=None, bx_batch=None,
                 bybit_host=None):
        self.ex, self.key, self.secret, self.passphrase = ex, key, secret, passphrase
        # Bybit: the host the key exists on — None both, "live" api.bybit.com only, "demo" api-demo only
        self.bybit_host = bybit_host
        # BingX /trade/batchOrders: None = what the bot's own notes report from production (code
        # 100001 on every symbol); "ok" / "list" = processed item by item (data.orders / data as a
        # list); "partial" = the SL item comes back without an orderId; "missing" = 100404
        self.bx_batch = bx_batch
        self.balance = float(balance)
        self.avail = None if avail is None else float(avail)
        self.perms = perms
        self.hedge = (ex != "bybit") if hedge is None else bool(hedge)
        self.leverage = {}
        self.positions = {}      # native → {"LONG": pos|None, "SHORT": pos|None}
        self.orders = []
        self.closed = []


class Sim:
    """coins: {native_symbol: {...}} per exchange, built by the driver:
    instruments[ex][native] = {price, tick, step, min_qty, max_lev, ct_val, lot_sz, funding, spread, status}"""

    def __init__(self, now, instruments, faults=None, moves=None):
        self.now = now
        self.inst = instruments
        self.accounts = {}
        self.faults = [dict(f, _seen=0) for f in (faults or [])]
        self.next_id = 7000
        self.lenient = []
        self.errors = []         # simulator crashes (a scaffolding bug, never an exchange answer) — the driver fails on any
        # price moves: [abs_ts, ex, native, new_price] applied when the clock passes abs_ts
        self.moves = sorted([list(m) for m in (moves or [])], key=lambda m: m[0])

    def _apply_moves(self):
        t = self.now()
        while self.moves and self.moves[0][0] <= t:
            _ts, ex, native, p = self.moves.pop(0)
            if native in self.inst.get(ex, {}):
                self.inst[ex][native]["price"] = p
                for (aex, _k), a in self.accounts.items():
                    if aex == ex:
                        self._match_resting(a, native)

    def _match_resting(self, a, native):
        """Resting orders of `native` against the new last price: marketable limits fill, crossed
        conditional (stop / take-profit) orders trigger and close (reduce) their side."""
        last = self.price(a.ex, native)
        keep = []
        fired = []
        for o in a.orders:
            if o["native"] != native:
                keep.append(o)
                continue
            if o["cond"]:
                trig = o.get("trigger") or 0
                long_side = o["pos_side"] == "LONG"
                hit = (last <= trig if long_side else last >= trig) if o["type"] == "STOP" else (last >= trig if long_side else last <= trig)
                (fired if hit and trig > 0 else keep).append(o)
                continue
            crosses = (o["price"] >= last if o["side"] == "BUY" else o["price"] <= last) if not o["reduce"] else (
                o["price"] <= last if o["side"] == "SELL" else o["price"] >= last)
            (fired if crosses else keep).append(o)
        a.orders = keep
        for o in fired:
            if o["cond"] or o["reduce"]:
                # OKX closeFraction "1": the whole position at trigger time
                self.reduce(a, native, o["pos_side"], float("inf") if o.get("close_all") else o["qty"])
            else:
                p = self.open(a, native, o["pos_side"], o["qty"], o["price"])
                if o.get("attached_sl"):
                    p["sl"] = o["attached_sl"]

    # ── accounts / helpers ──
    def add_account(self, ex, key, secret, **kw):
        a = Account(ex, key, secret, **kw)
        self.accounts[(ex, key)] = a
        return a

    def new_id(self):
        self.next_id += 1
        return self.next_id

    def price(self, ex, native):
        i = self.inst.get(ex, {}).get(native)
        return None if i is None else i["price"]

    def ms(self):
        return int(self.now() * 1000)

    def pos(self, a, native, side):
        p = a.positions.get(native)
        return p[side] if p and p.get(side) and p[side]["size"] > 0 else None

    def open(self, a, native, side, qty, price):
        p = a.positions.setdefault(native, {"LONG": None, "SHORT": None})
        cur = p[side]
        if cur and cur["size"] > 0:
            size = cur["size"] + qty
            cur["entry"] = (cur["entry"] * cur["size"] + price * qty) / size
            cur["size"] = size
        else:
            p[side] = {"size": qty, "entry": price, "sl": 0.0, "tp": 0.0, "lev": a.leverage.get(native, 10), "ts": self.now()}
        return p[side]

    def reduce(self, a, native, side, qty):
        cur = self.pos(a, native, side)
        if not cur:
            return 0.0
        q = min(qty, cur["size"])
        cur["size"] = round(cur["size"] - q, 10)
        last = self.price(a.ex, native) or cur["entry"]
        pnl = (last - cur["entry"]) * q * (1 if side == "LONG" else -1)
        a.closed.append({"native": native, "side": side, "qty": q, "entry": cur["entry"], "exit": last, "pnl": pnl, "ts": self.now()})
        if cur["size"] <= 1e-12:
            a.positions[native][side] = None
            a.orders = [o for o in a.orders if not (o["native"] == native and o["pos_side"] == side and (o["reduce"] or o["cond"]))]
        return q

    def all_positions(self, a):
        out = []
        for native, p in a.positions.items():
            for side in ("LONG", "SHORT"):
                if p.get(side) and p[side]["size"] > 0:
                    out.append((native, side, p[side]))
        return out

    def place(self, a, o):
        """o = {native, side BUY|SELL, pos_side LONG|SHORT, type MARKET|LIMIT|STOP|TP, qty, price, trigger, reduce, cid}"""
        last = self.price(a.ex, o["native"])
        oid = self.new_id()
        reducing = o.get("reduce") or (o["side"] == "SELL" and o["pos_side"] == "LONG") or (o["side"] == "BUY" and o["pos_side"] == "SHORT")
        rec = dict(o, id=oid, ts=self.now(), cond=False)
        if o["type"] in ("STOP", "TP"):
            rec.update(cond=True, reduce=True)
            a.orders.append(rec)
            return {"ok": True, "id": oid, "filled": False}
        if reducing:
            if not self.pos(a, o["native"], o["pos_side"]):
                return {"ok": False, "reason": "reduce_only"}
            if o["type"] == "LIMIT":
                crosses = o["price"] <= last if o["side"] == "SELL" else o["price"] >= last
                if not crosses:
                    rec.update(reduce=True)
                    a.orders.append(rec)
                    return {"ok": True, "id": oid, "filled": False}
            q = self.reduce(a, o["native"], o["pos_side"], o["qty"])
            return {"ok": True, "id": oid, "filled": True, "qty": q, "avg": last}
        if o["type"] == "LIMIT":
            crosses = o["price"] >= last if o["side"] == "BUY" else o["price"] <= last
            if not crosses:
                rec.update(reduce=False)
                a.orders.append(rec)
                return {"ok": True, "id": oid, "filled": False}
            self.open(a, o["native"], o["pos_side"], o["qty"], o["price"])
            return {"ok": True, "id": oid, "filled": True, "qty": o["qty"], "avg": o["price"]}
        self.open(a, o["native"], o["pos_side"], o["qty"], last)
        return {"ok": True, "id": oid, "filled": True, "qty": o["qty"], "avg": last}

    def cancel_all(self, a, native):
        gone = [o for o in a.orders if o["native"] == native]
        a.orders = [o for o in a.orders if o["native"] != native]
        return gone

    # ── faults ──
    def fault_for(self, ex, method, path):
        for f in self.faults:
            if f["ex"] != ex or f["path"] != path:
                continue
            if f.get("method") and f["method"] != method:
                continue
            f["_seen"] += 1
            if f["nth"] == "all" or f["nth"] == f["_seen"] or (isinstance(f["nth"], list) and f["_seen"] in f["nth"]):
                return f
        return None

    # ── entry point ──
    def handle(self, method, url, headers, body):
        """→ {"status", "headers", "text"} | {"hang": True} | {"connect": msg}; + "sig_ok", "ex", "applied"."""
        u = urllib.parse.urlsplit(url)
        host, path, raw_qs = u.hostname or "", u.path, u.query
        query = parse_qs(raw_qs)
        raw_body = body if isinstance(body, str) else (body.decode() if isinstance(body, bytes) else "")
        parsed = {}
        if raw_body:
            try:
                parsed = json.loads(raw_body)
            except Exception:  # noqa: BLE001
                parsed = parse_qs(raw_body)
        hl = {k.lower(): v for k, v in (headers or {}).items()}
        self._apply_moves()
        if host.endswith("bybit.com"):
            ex = "bybit"
        elif host == "open-api.bingx.com":
            ex = "bingx"
        elif host.endswith("binance.com"):
            ex = "binance"
        elif host == "www.okx.com":
            ex = "okx"
        else:
            return {"status": 404, "headers": {"Content-Type": "text/plain"}, "text": "no route", "ex": None, "sig_ok": None}
        f = self.fault_for(ex, method, path)
        meta = {"ex": ex, "fault": (f or {}).get("label") or ((f or {}).get("kind"))}
        sig = self._sig_ok(ex, method, path, raw_qs, raw_body, hl)
        if f and f["kind"] == "connect":
            return dict(meta, connect=f.get("message", "Cannot connect to host"), sig_ok=sig)
        if f and f["kind"] == "hang":
            return dict(meta, hang=True, sig_ok=sig)
        if f and f["kind"] == "status":
            return dict(meta, status=f.get("status", 502), headers={"Content-Type": f.get("ctype", "text/html")},
                        text=f.get("text", "<html><body><h1>502 Bad Gateway</h1></body></html>"), sig_ok=sig)
        if f and f["kind"] == "resp":
            hdrs = dict(f.get("headers") or {})
            for k, v in list(hdrs.items()):
                if v == "$RESET_MS":
                    hdrs[k] = str(self.ms() + int(f.get("reset_in_ms", 500)))
            out = resp(f["json"], f.get("status", 200), hdrs)
            out.update(meta, sig_ok=sig)
            return out
        fn = {"bybit": self.bybit, "bingx": self.bingx, "binance": self.binance, "okx": self.okx}[ex]
        self._batch_fault = f if f and f["kind"] == "batch_item" else None
        try:
            out = fn(method, host, path, query, parsed, hl, raw_qs, raw_body, url)
        except Exception as e:  # noqa: BLE001
            import traceback
            self.errors.append([ex, method, path, f"{type(e).__name__}: {e}", traceback.format_exc()[-800:]])
            out = {"status": 500, "headers": {"Content-Type": "text/plain"}, "text": "simulator error"}
        self._batch_fault = None
        if out is None:
            out = {"status": 404, "headers": {"Content-Type": "text/plain"}, "text": "no route", "unhandled": True}
        out.update(meta)
        out.setdefault("sig_ok", self._sig_ok(ex, method, path, raw_qs, raw_body, hl))
        if f and f["kind"] == "hang_accept":
            return dict(meta, hang=True, accepted=out.get("text"), sig_ok=out["sig_ok"])
        if f and f["kind"] == "slow":
            # applied now, answered after `delay` s (a timeout when the client gives up first)
            out["delay"] = float(f.get("delay", 5.0))
        return out

    def _account(self, ex, hl):
        key = {"bybit": "x-bapi-api-key", "bingx": "x-bx-apikey", "binance": "x-mbx-apikey", "okx": "ok-access-key"}[ex]
        return self.accounts.get((ex, hl.get(key)))

    def _sig_ok(self, ex, method, path, raw_qs, raw_body, hl):
        a = self._account(ex, hl)
        if a is None:
            return None
        if ex == "bybit":
            if "x-bapi-sign" not in hl:
                return None
            payload = raw_qs if method == "GET" else raw_body
            pre = str(hl.get("x-bapi-timestamp")) + a.key + str(hl.get("x-bapi-recv-window")) + (payload or "")
            return hmac.new(a.secret.encode(), pre.encode(), hashlib.sha256).hexdigest() == hl.get("x-bapi-sign")
        if ex in ("bingx", "binance"):
            if "&signature=" not in raw_qs and not raw_qs.startswith("signature="):
                return None
            unsigned, _, sig = raw_qs.rpartition("signature=")
            unsigned = unsigned[:-1] if unsigned.endswith("&") else unsigned
            return hmac.new(a.secret.encode(), unsigned.encode(), hashlib.sha256).hexdigest() == sig
        if "ok-access-sign" not in hl:
            return None
        pq = path + ("?" + raw_qs if raw_qs else "")
        pre = str(hl.get("ok-access-timestamp")) + method + pq + (raw_body or "")
        want = base64.b64encode(hmac.new(a.secret.encode(), pre.encode(), hashlib.sha256).digest()).decode()
        return want == hl.get("ok-access-sign") and hl.get("ok-access-passphrase") == a.passphrase

    # ══════════════════════════ Bybit v5 ══════════════════════════
    def bybit(self, method, host, path, q, body, hl, raw_qs, raw_body, url):
        inst = self.inst["bybit"]

        def ok(result):
            return resp({"retCode": 0, "retMsg": "OK", "result": result, "retExtInfo": {}, "time": self.ms()})

        def err(code, msg):
            return resp({"retCode": code, "retMsg": msg, "result": {}, "retExtInfo": {}, "time": self.ms()})

        if path == "/v5/market/time":
            t = self.now()
            return ok({"timeSecond": str(int(t)), "timeNano": str(int(t * 1e9))})
        if path == "/v5/market/instruments-info":
            i = inst.get(q.get("symbol"))
            if not i:
                return ok({"category": "linear", "list": [], "nextPageCursor": ""})
            return ok({"category": "linear", "list": [{
                "symbol": q.get("symbol"), "status": i.get("status", "Trading"), "contractType": "LinearPerpetual",
                "lotSizeFilter": {"qtyStep": fmt(i["step"]), "minOrderQty": fmt(i.get("min_qty", i["step"])), "maxOrderQty": "1000000",
                                  "minNotionalValue": "5"},
                "priceFilter": {"tickSize": fmt(i["tick"]), "minPrice": fmt(i["tick"]), "maxPrice": "1999999"},
                "leverageFilter": {"minLeverage": "1", "maxLeverage": fmt(i.get("max_lev", 100)), "leverageStep": "0.01"}}],
                "nextPageCursor": ""})
        if path == "/v5/market/tickers":
            i = inst.get(q.get("symbol"))
            if not i:
                return ok({"category": "linear", "list": []})
            p = i["price"]
            sp = i.get("spread", 1) * i["tick"]
            return ok({"category": "linear", "list": [{
                "symbol": q.get("symbol"), "lastPrice": fmt(p), "markPrice": fmt(p), "indexPrice": fmt(p),
                "bid1Price": fmt(p - sp / 2), "ask1Price": fmt(p + sp / 2), "fundingRate": fmt(i.get("funding", 0.0001), 8)}]})
        a = self._account("bybit", hl)
        if a is not None and a.bybit_host and (a.bybit_host == "demo") != (host == "api-demo.bybit.com"):
            a = None
        if a is None:
            return err(10003, "API key is invalid.")
        if self._sig_ok("bybit", method, path, raw_qs, raw_body, hl) is False:
            return err(10004, "error sign! origin_string[...]")
        demo_host = host == "api-demo.bybit.com"

        def prow(native, side, p):
            mp = self.price("bybit", native) or p["entry"]
            return {"symbol": native, "side": "Buy" if side == "LONG" else "Sell", "size": fmt(p["size"]),
                    "positionIdx": (1 if side == "LONG" else 2) if a.hedge else 0, "avgPrice": fmt(p["entry"]),
                    "markPrice": fmt(mp), "stopLoss": fmt(p["sl"]) if p["sl"] else "", "takeProfit": fmt(p["tp"]) if p["tp"] else "",
                    "leverage": str(p["lev"]), "unrealisedPnl": fmt((mp - p["entry"]) * p["size"] * (1 if side == "LONG" else -1), 6),
                    "positionValue": fmt(p["size"] * p["entry"], 6), "tradeMode": 0, "positionStatus": "Normal",
                    "createdTime": str(int(p["ts"] * 1000)), "updatedTime": str(self.ms())}
        if path == "/v5/user/query-api":
            return ok({"id": "1", "apiKey": a.key, "readOnly": 0, "permissions": a.perms or {
                "ContractTrade": ["Order", "Position"], "Spot": [], "Wallet": ["AccountTransfer"], "Options": [], "Derivatives": [],
                "Exchange": [], "NFT": [], "Affiliate": []}})
        if path == "/v5/account/wallet-balance":
            av = a.balance if a.avail is None else a.avail
            return ok({"list": [{"accountType": q.get("accountType", "UNIFIED"), "totalEquity": fmt(a.balance, 4),
                                 "totalAvailableBalance": fmt(av, 4), "totalWalletBalance": fmt(a.balance, 4), "totalUnrealisedPnl": "0",
                                 "coin": [{"coin": "USDT", "walletBalance": fmt(a.balance, 4), "equity": fmt(a.balance, 4),
                                           "availableToWithdraw": "", "availableBalance": ""}]}]})
        if path == "/v5/position/switch-isolated":
            return err(110026, "Cross/isolated margin mode is not modified")
        if path == "/v5/position/switch-mode":
            return ok({})
        if path == "/v5/position/set-leverage":
            native = body.get("symbol")
            i = inst.get(native)
            if i and float(body.get("buyLeverage") or 0) > i.get("max_lev", 100):
                return err(10001, f"leverage invalid, maxLeverage [{int(i.get('max_lev', 100) * 100)}]")
            if a.leverage.get(native) == float(body.get("buyLeverage") or 0):
                return err(110043, "leverage not modified")
            a.leverage[native] = float(body.get("buyLeverage") or 0)
            return ok({})
        if path == "/v5/position/list":
            sym = q.get("symbol")
            rows = [prow(n, s, p) for n, s, p in self.all_positions(a) if not sym or n == sym]
            if sym and not rows:
                rows = [{"symbol": sym, "side": "", "size": "0", "positionIdx": 0, "avgPrice": "0",
                         "markPrice": fmt(self.price("bybit", sym) or 0), "stopLoss": "", "takeProfit": "", "leverage": "10",
                         "unrealisedPnl": "0"}]
            return ok({"category": "linear", "list": rows, "nextPageCursor": ""})
        if path == "/v5/order/create":
            native = body.get("symbol")
            i = inst.get(native)
            if not i:
                return err(10001, "params error: symbol invalid")
            if i.get("status", "Trading") != "Trading":
                return err(110074, "This contract is not live")
            pidx = int(body.get("positionIdx") or 0)
            if a.hedge and pidx == 0 or (not a.hedge and pidx != 0):
                return err(10001, "position idx not match position mode")
            side = "BUY" if body.get("side") == "Buy" else "SELL"
            reduce = bool(body.get("reduceOnly"))
            if a.hedge:
                pos_side = "LONG" if pidx == 1 else "SHORT"
            else:
                pos_side = ("SHORT" if side == "BUY" else "LONG") if reduce else ("LONG" if side == "BUY" else "SHORT")
            qty = float(body.get("qty") or 0)
            step = i["step"]
            if qty <= 0 or abs(qty / step - round(qty / step)) > 1e-6:
                return err(10001, "Qty invalid")
            if body.get("orderLinkId") and any(o.get("cid") == body["orderLinkId"] for o in a.orders) or (
                    body.get("orderLinkId") and body["orderLinkId"] in getattr(a, "_links", set())):
                return err(110072, "OrderLinkedID is duplicate")
            px = float(body.get("price") or 0)
            if not reduce:
                need = qty * (px or i["price"]) / max(1.0, a.leverage.get(native, 10))
                if need > (a.balance if a.avail is None else a.avail):
                    return err(110007, "ab not enough for new order")
            r = self.place(a, {"native": native, "side": side, "pos_side": pos_side,
                               "type": "MARKET" if body.get("orderType") == "Market" else "LIMIT", "qty": qty, "price": px,
                               "trigger": 0.0, "reduce": reduce, "cid": body.get("orderLinkId") or ""})
            if not r["ok"]:
                return err(110017, "current position is zero, cannot fix reduce-only order qty")
            if body.get("orderLinkId"):
                a.__dict__.setdefault("_links", set()).add(body["orderLinkId"])
            if r["filled"] and not reduce:
                p = self.pos(a, native, pos_side)
                if body.get("stopLoss"):
                    p["sl"] = float(body["stopLoss"])
                if body.get("takeProfit"):
                    p["tp"] = float(body["takeProfit"])
            elif not r["filled"] and not reduce and body.get("stopLoss"):
                for o in a.orders:
                    if o["id"] == r["id"]:
                        o["attached_sl"] = float(body["stopLoss"])
            return ok({"orderId": f"by-{r['id']}", "orderLinkId": body.get("orderLinkId") or ""})
        if path == "/v5/position/trading-stop":
            native = body.get("symbol")
            pidx = int(body.get("positionIdx") or 0)
            if a.hedge:
                p = self.pos(a, native, "LONG" if pidx == 1 else "SHORT")
            else:
                p = self.pos(a, native, "LONG") or self.pos(a, native, "SHORT")
            if not p:
                return err(10001, "can not set tp/sl/ts for zero position")
            if "stopLoss" in body:
                new = float(body.get("stopLoss") or 0)
                if new and new == p["sl"]:
                    return err(34040, "not modified")
                p["sl"] = new
            if "takeProfit" in body:
                p["tp"] = float(body.get("takeProfit") or 0)
            return ok({})
        if path == "/v5/order/realtime":
            sym = q.get("symbol")
            lst = [{"orderId": f"by-{o['id']}", "orderLinkId": o.get("cid") or "", "symbol": o["native"],
                    "side": "Buy" if o["side"] == "BUY" else "Sell", "orderType": "Market" if o["type"] == "MARKET" else "Limit",
                    "price": fmt(o.get("price") or 0), "qty": fmt(o["qty"]), "reduceOnly": bool(o["reduce"]),
                    "orderStatus": "Untriggered" if o["cond"] else "New", "triggerPrice": fmt(o["trigger"]) if o.get("trigger") else "",
                    "stopOrderType": ("StopLoss" if o["type"] == "STOP" else ("TakeProfit" if o["type"] == "TP" else "")),
                    "positionIdx": (1 if o["pos_side"] == "LONG" else 2) if a.hedge else 0,
                    "createdTime": str(int(o["ts"] * 1000))}
                   for o in a.orders if not sym or o["native"] == sym]
            return ok({"category": "linear", "list": lst, "nextPageCursor": ""})
        if path == "/v5/order/cancel-all":
            gone = self.cancel_all(a, body.get("symbol"))
            return ok({"list": [{"orderId": f"by-{o['id']}", "orderLinkId": o.get("cid") or ""} for o in gone], "success": "1"})
        if path == "/v5/order/cancel":
            n = len(a.orders)
            a.orders = [o for o in a.orders if f"by-{o['id']}" != body.get("orderId")]
            return err(110001, "order not exists or too late to cancel") if n == len(a.orders) else ok({"orderId": body.get("orderId")})
        if path == "/v5/position/closed-pnl":
            sym = q.get("symbol")
            lst = [{"symbol": c["native"], "side": "Buy" if c["side"] == "LONG" else "Sell", "qty": fmt(c["qty"]),
                    "avgEntryPrice": fmt(c["entry"]), "avgExitPrice": fmt(c["exit"]), "closedPnl": fmt(c["pnl"], 6),
                    "updatedTime": str(int(c["ts"] * 1000)), "createdTime": str(int(c["ts"] * 1000)), "orderLinkId": ""}
                   for c in reversed(a.closed) if not sym or c["native"] == sym]
            return ok({"category": "linear", "list": lst[:int(q.get("limit") or 50)], "nextPageCursor": ""})
        if path == "/v5/execution/list":
            return ok({"category": "linear", "list": [], "nextPageCursor": ""})
        _ = demo_host
        return None

    # ══════════════════════════ BingX swap v2 ══════════════════════════
    def bingx(self, method, host, path, q, body, hl, raw_qs, raw_body, url):
        inst = self.inst["bingx"]

        def ok(data):
            return resp({"code": 0, "msg": "", "data": data})

        def err(code, msg):
            return resp({"code": code, "msg": msg, "data": {}})

        if path == "/openApi/swap/v2/quote/contracts":
            return ok([{"symbol": n, "tradeMinQuantity": i["step"], "quantityPrecision": max(0, len(fmt(i["step"]).partition(".")[2])),
                        "pricePrecision": max(0, len(fmt(i["tick"]).partition(".")[2])), "maxLeverage": i.get("max_lev", 100),
                        "status": 1 if i.get("status", "Trading") == "Trading" else 0, "currency": "USDT", "asset": n.split("-")[0]}
                       for n, i in inst.items()])
        if path == "/openApi/server/v1/time":
            return ok({"serverTime": self.ms()})
        if path == "/openApi/swap/v2/quote/price":
            p = self.price("bingx", q.get("symbol"))
            return err(109400, "symbol not exist") if p is None else ok({"symbol": q.get("symbol"), "price": fmt(p), "time": self.ms()})
        a = self._account("bingx", hl)
        if a is None:
            return err(100413, "Incorrect apiKey")
        if self._sig_ok("bingx", method, path, raw_qs, raw_body, hl) is False:
            return err(100001, "Signature verification failed")

        def prow(native, side, p):
            mp = self.price("bingx", native) or p["entry"]
            return {"symbol": native, "positionSide": side, "positionAmt": fmt(p["size"]), "avgPrice": fmt(p["entry"]),
                    "markPrice": fmt(mp), "unrealizedProfit": fmt((mp - p["entry"]) * p["size"] * (1 if side == "LONG" else -1), 6),
                    "leverage": p["lev"], "stopLoss": fmt(p["sl"]) if p["sl"] else ""}

        def orow(o):
            return {"orderId": o["id"], "symbol": o["native"], "side": o["side"], "positionSide": o["pos_side"],
                    "type": {"STOP": "STOP_MARKET", "TP": "TAKE_PROFIT_MARKET"}.get(o["type"], o["type"]),
                    "price": fmt(o.get("price") or 0), "origQty": fmt(o["qty"]), "stopPrice": fmt(o.get("trigger") or 0),
                    "clientOrderId": o.get("cid") or "", "status": "NEW", "time": int(o["ts"] * 1000)}
        def one(q):
            """One order (POST /trade/order or one batchOrders item) → its data dict | (code, msg)."""
            native = q.get("symbol")
            i = inst.get(native)
            if not i:
                return (109400, "symbol not exist")
            if i.get("status", "Trading") != "Trading":
                return (109414, "trading pair is suspended")
            side = q.get("side", "")
            if side != side.upper():
                self.lenient.append(["bingx", path, f"side {side}"])
                side = side.upper()
            typ = {"STOP_MARKET": "STOP", "TAKE_PROFIT_MARKET": "TP", "TAKE_PROFIT": "TP"}.get(q.get("type"), q.get("type"))
            ps = q.get("positionSide")
            if not ps:
                self.lenient.append(["bingx", path, f"no positionSide ({q.get('type')})"])
                ps = "LONG"
            if ps == "BOTH":
                if a.hedge:
                    return (109400, "positionSide BOTH is not allowed in hedge mode")
                ps = ("SHORT" if side == "BUY" else "LONG") if q.get("reduceOnly") == "true" or typ in ("STOP", "TP") else ("LONG" if side == "BUY" else "SHORT")
            elif not a.hedge:
                return (109400, "In the One-way mode, the 'PositionSide' field can only be set to BOTH")
            if ps not in ("LONG", "SHORT"):
                return (109400, "positionSide error")
            cid = q.get("clientOrderId") or ""
            if cid and cid in getattr(a, "_links", set()):
                return (101404, "duplicate clientOrderId")
            qty = float(q.get("quantity") or 0)
            step = i["step"]
            if qty <= 0 or abs(qty / step - round(qty / step)) > 1e-6:
                return (109400, "quantity precision is invalid")
            px = float(q.get("price") or 0)
            reducing = q.get("reduceOnly") == "true" or (side == "SELL" and ps == "LONG") or (side == "BUY" and ps == "SHORT")
            if not reducing and typ in ("MARKET", "LIMIT"):
                need = qty * (px or i["price"]) / max(1.0, a.leverage.get(native, 10))
                if need > (a.balance if a.avail is None else a.avail):
                    return (101204, "Insufficient margin")
            r = self.place(a, {"native": native, "side": side, "pos_side": ps, "type": typ, "qty": qty, "price": px,
                               "trigger": float(q.get("stopPrice") or 0), "reduce": q.get("reduceOnly") == "true", "cid": cid})
            if not r["ok"]:
                return (101205, "No position to close")
            if cid:
                a.__dict__.setdefault("_links", set()).add(cid)
            return {"order": {"orderId": r["id"], "symbol": native, "side": side, "positionSide": ps, "type": q.get("type"),
                              "clientOrderId": cid}}

        if path == "/openApi/v1/account/apiPermissions":
            return ok({"ipAddresses": [], "note": "autotrade", "permissions": a.perms or [1, 2, 3]})
        if path == "/openApi/swap/v2/user/balance":
            av = a.balance if a.avail is None else a.avail
            return ok({"balance": {"userId": "1", "asset": "USDT", "balance": fmt(a.balance, 4), "equity": fmt(a.balance, 4),
                                   "unrealizedProfit": "0", "availableMargin": fmt(av, 4)}})
        if path == "/openApi/swap/v1/user/balance":
            return ok([{"balance": fmt(a.balance, 4)}])
        if path == "/openApi/swap/v2/trade/leverage":
            side = q.get("side")
            if a.hedge and side == "BOTH" or (not a.hedge and side in ("LONG", "SHORT")):
                return err(109400, "In the One-way mode, the 'PositionSide' field can only be set to BOTH")
            if a.leverage.get(q.get("symbol")) == float(q.get("leverage") or 0):
                return err(80014, "leverage not changed")
            a.leverage[q.get("symbol")] = float(q.get("leverage") or 0)
            return ok({"leverage": int(float(q.get("leverage") or 0)), "symbol": q.get("symbol")})
        if path == "/openApi/swap/v2/trade/batchOrders":
            mode = a.bx_batch
            if mode is None:
                return err(100001, "Signature verification failed")
            if mode == "missing":
                return err(100404, "api not found")
            items = json.loads(q.get("batchOrders") or "[]")
            out = []
            for k, it in enumerate(items):
                if mode == "partial" and k == 1:
                    out.append({})
                    continue
                r = one({kk: (vv if isinstance(vv, str) else json.dumps(vv)) for kk, vv in it.items()})
                out.append({"code": r[0], "msg": r[1]} if isinstance(r, tuple) else r["order"])
            return ok(out if mode == "list" else {"orders": out})
        if path == "/openApi/swap/v2/trade/order":
            if method == "DELETE":
                n = len(a.orders)
                a.orders = [o for o in a.orders if str(o["id"]) != str(q.get("orderId"))]
                return err(109400, "order not exist") if n == len(a.orders) else ok({"order": {"orderId": int(q.get("orderId"))}})
            if method == "GET":
                # query by clientOrderId ([BINGX-DUP-VERIFY]): an order accepted with this cid exists
                cid = q.get("clientOrderId") or ""
                if cid and cid in getattr(a, "_links", set()):
                    return ok({"order": {"symbol": q.get("symbol"), "clientOrderId": cid, "status": "NEW"}})
                return err(109400, "order not exist")
            r = one(q)
            return err(r[0], r[1]) if isinstance(r, tuple) else ok(r)
        if path == "/openApi/swap/v2/user/positions":
            sym = q.get("symbol")
            return ok([prow(n, s, p) for n, s, p in self.all_positions(a) if not sym or n == sym])
        if path == "/openApi/swap/v2/trade/openOrders":
            sym = q.get("symbol")
            return ok({"orders": [orow(o) for o in a.orders if not sym or o["native"] == sym]})
        if path == "/openApi/swap/v2/trade/allOpenOrders":
            gone = self.cancel_all(a, q.get("symbol"))
            g = [{"orderId": o["id"]} for o in gone]
            return ok({"success": g, "orders": g})
        if path == "/openApi/swap/v2/trade/allFillOrders":
            return ok({"fill_orders": []})
        if path == "/openApi/swap/v2/trade/allOrders":
            sym = q.get("symbol")
            lst = [{"symbol": c["native"], "side": "SELL" if c["side"] == "LONG" else "BUY", "avgPrice": fmt(c["exit"]),
                    "price": fmt(c["exit"]), "updateTime": int(c["ts"] * 1000), "time": int(c["ts"] * 1000), "profit": fmt(c["pnl"], 6),
                    "clientOrderId": "", "status": "FILLED"} for c in reversed(a.closed) if not sym or c["native"] == sym]
            return ok({"orders": lst})
        return None

    # ══════════════════════════ Binance USDⓈ-M ══════════════════════════
    def binance(self, method, host, path, q, body, hl, raw_qs, raw_body, url):
        inst = self.inst["binance"]

        def err(code, msg, status=400):
            return resp({"code": code, "msg": msg}, status)
        if path == "/fapi/v1/ping":
            return resp({})
        if path == "/fapi/v1/time":
            return resp({"serverTime": self.ms()})
        if path == "/fapi/v1/exchangeInfo":
            return resp({"timezone": "UTC", "serverTime": self.ms(), "symbols": [{
                "symbol": n, "status": "TRADING" if i.get("status", "Trading") == "Trading" else "SETTLING", "contractType": "PERPETUAL",
                "quoteAsset": "USDT",
                "filters": [{"filterType": "PRICE_FILTER", "tickSize": fmt(i["tick"]), "minPrice": fmt(i["tick"]), "maxPrice": "10000000"},
                            {"filterType": "LOT_SIZE", "stepSize": fmt(i["step"]), "minQty": fmt(i.get("min_qty", i["step"])), "maxQty": "1000000"},
                            {"filterType": "MARKET_LOT_SIZE", "stepSize": fmt(i["step"]), "minQty": fmt(i.get("min_qty", i["step"])), "maxQty": "1000000"},
                            {"filterType": "MIN_NOTIONAL", "notional": "5"}]} for n, i in inst.items()]})
        if path == "/fapi/v1/ticker/price":
            p = self.price("binance", q.get("symbol"))
            return err(-1121, "Invalid symbol.") if p is None else resp({"symbol": q.get("symbol"), "price": fmt(p), "time": self.ms()})
        a = self._account("binance", hl)
        if a is None:
            return err(-2015, "Invalid API-key, IP, or permissions for action.", 401)
        if self._sig_ok("binance", method, path, raw_qs, raw_body, hl) is False:
            return err(-1022, "Signature for this request is not valid.")
        if host == "api.binance.com":
            if path == "/sapi/v1/account/apiRestrictions":
                return resp({"ipRestrict": False, "createTime": 1767000000000, "enableReading": True,
                             "enableWithdrawals": bool(a.perms and a.perms.get("withdraw")), "enableInternalTransfer": False,
                             "enableMargin": False, "enableFutures": True, "permitsUniversalTransfer": False,
                             "enableVanillaOptions": False, "enableSpotAndMarginTrading": False})
            return None

        def prows(sym):
            out = []
            for n in inst:
                if sym and n != sym:
                    continue
                sides = ("LONG", "SHORT") if a.hedge else ("BOTH",)
                for side in sides:
                    if side == "BOTH":
                        p = self.pos(a, n, "LONG") or self.pos(a, n, "SHORT")
                        sgn = 1 if self.pos(a, n, "LONG") else -1
                    else:
                        p = self.pos(a, n, side)
                        sgn = 1 if side == "LONG" else -1
                    if not p and not sym:
                        continue
                    mp = self.price("binance", n) or 0
                    out.append({"symbol": n, "positionSide": side, "positionAmt": fmt(sgn * p["size"]) if p else "0.000",
                                "entryPrice": fmt(p["entry"]) if p else "0.0", "markPrice": fmt(mp),
                                "unRealizedProfit": fmt((mp - p["entry"]) * p["size"] * sgn, 6) if p else "0.00000000",
                                "liquidationPrice": "0", "leverage": str(int(a.leverage.get(n, 10))), "marginType": "cross"})
            return out

        def orow(o):
            return {"orderId": o["id"], "symbol": o["native"], "status": "NEW", "clientOrderId": o.get("cid") or "",
                    "price": fmt(o.get("price") or 0), "avgPrice": "0", "origQty": fmt(o["qty"]), "executedQty": "0",
                    "type": {"STOP": "STOP_MARKET", "TP": "TAKE_PROFIT_MARKET"}.get(o["type"], o["type"]), "side": o["side"],
                    "positionSide": o["pos_side"] if a.hedge else "BOTH", "stopPrice": fmt(o.get("trigger") or 0),
                    "reduceOnly": bool(o["reduce"]), "closePosition": False, "time": int(o["ts"] * 1000), "updateTime": int(o["ts"] * 1000)}

        def one(p):
            native = p.get("symbol")
            i = inst.get(native)
            if not i:
                return {"code": -1121, "msg": "Invalid symbol."}
            if i.get("status", "Trading") != "Trading":
                return {"code": -4140, "msg": "Invalid symbol status for opening position."}
            ps = p.get("positionSide")
            if a.hedge and not ps or (not a.hedge and ps not in (None, "", "BOTH")) or ps not in (None, "", "BOTH", "LONG", "SHORT"):
                return {"code": -4061, "msg": "Order's position side does not match user's setting."}
            typ = {"STOP_MARKET": "STOP", "TAKE_PROFIT_MARKET": "TP"}.get(p.get("type"), p.get("type"))
            side = p.get("side")
            reduce_flag = str(p.get("reduceOnly")).lower() == "true"
            if not ps or ps == "BOTH":
                if typ in ("STOP", "TP") or reduce_flag:
                    ps = "LONG" if side == "SELL" else "SHORT"
                else:
                    ps = "LONG" if side == "BUY" else "SHORT"
            cid = p.get("newClientOrderId") or ""
            if cid and cid in getattr(a, "_links", set()):
                return {"code": -4015, "msg": "Client order id is not valid."}
            qty = float(p.get("quantity") or 0)
            if qty <= 0 or abs(qty / i["step"] - round(qty / i["step"])) > 1e-6:
                return {"code": -1111, "msg": "Precision is over the maximum defined for this asset."}
            px = float(p.get("price") or 0)
            reducing = reduce_flag or (side == "SELL" and ps == "LONG") or (side == "BUY" and ps == "SHORT")
            if not reducing and typ in ("MARKET", "LIMIT"):
                need = qty * (px or i["price"]) / max(1.0, a.leverage.get(native, 10))
                if need > (a.balance if a.avail is None else a.avail):
                    return {"code": -2019, "msg": "Margin is insufficient."}
            r = self.place(a, {"native": native, "side": side, "pos_side": ps, "type": typ, "qty": qty, "price": px,
                               "trigger": float(p.get("stopPrice") or 0), "reduce": reduce_flag, "cid": cid})
            if not r["ok"]:
                return {"code": -2022, "msg": "ReduceOnly Order is rejected."}
            if cid:
                a.__dict__.setdefault("_links", set()).add(cid)
            return {"orderId": r["id"], "symbol": native, "status": "FILLED" if r["filled"] else "NEW", "clientOrderId": cid,
                    "price": fmt(px), "avgPrice": fmt(r["avg"]) if r["filled"] else "0.00000", "origQty": str(p.get("quantity")),
                    "executedQty": str(p.get("quantity")) if r["filled"] else "0", "type": p.get("type"), "side": side,
                    "positionSide": ps if a.hedge else "BOTH"}
        if path == "/fapi/v2/balance":
            av = a.balance if a.avail is None else a.avail
            return resp([{"accountAlias": "Fk", "asset": "USDT", "balance": fmt(a.balance, 8), "crossWalletBalance": fmt(a.balance, 8),
                          "crossUnPnl": "0.00000000", "availableBalance": fmt(av, 8), "maxWithdrawAmount": fmt(av, 8)}])
        if path == "/fapi/v1/positionSide/dual":
            if method == "GET":
                return resp({"dualSidePosition": a.hedge})
            want = str(q.get("dualSidePosition")).lower() == "true"
            if want == a.hedge:
                return err(-4059, "No need to change position side.")
            if any(True for _ in self.all_positions(a)) or a.orders:
                return err(-4068, "Position side cannot be changed if there exists position.")
            a.hedge = want
            return resp({"code": 200, "msg": "success"})
        if path == "/fapi/v1/leverage":
            native = q.get("symbol")
            i = inst.get(native)
            lev = int(float(q.get("leverage") or 0))
            if i and lev > i.get("max_lev", 125):
                return err(-4028, f"Leverage {lev} is not valid")
            a.leverage[native] = lev
            return resp({"leverage": lev, "maxNotionalValue": "1000000", "symbol": native})
        if path == "/fapi/v1/leverageBracket":
            native = q.get("symbol")
            i = inst.get(native) or {}
            return resp([{"symbol": native, "brackets": [{"bracket": 1, "initialLeverage": int(i.get("max_lev", 125)),
                                                          "notionalCap": 50000, "notionalFloor": 0, "maintMarginRatio": 0.004, "cum": 0.0}]}])
        if path == "/fapi/v1/batchOrders":
            lst = json.loads(q.get("batchOrders") or "[]")
            bad = (self._batch_fault or {}).get("items") or {}
            return resp([dict(bad[str(i)]) if str(i) in bad else one(p) for i, p in enumerate(lst)])
        if path == "/fapi/v1/order":
            if method == "DELETE":
                n = len(a.orders)
                a.orders = [o for o in a.orders if str(o["id"]) != str(q.get("orderId"))]
                return err(-2011, "Unknown order sent.") if n == len(a.orders) else resp({"orderId": int(q.get("orderId")), "status": "CANCELED"})
            r = one(q)
            return err(r["code"], r["msg"]) if "code" in r and r["code"] < 0 else resp(r)
        if path == "/fapi/v2/positionRisk":
            return resp(prows(q.get("symbol")))
        if path == "/fapi/v1/openOrders":
            sym = q.get("symbol")
            return resp([orow(o) for o in a.orders if not sym or o["native"] == sym])
        if path == "/fapi/v1/allOpenOrders":
            self.cancel_all(a, q.get("symbol"))
            return resp({"code": 200, "msg": "The operation of cancel all open order is done."})
        if path == "/fapi/v1/userTrades":
            sym = q.get("symbol")
            lst = [{"symbol": c["native"], "side": "SELL" if c["side"] == "LONG" else "BUY", "price": fmt(c["exit"]), "qty": fmt(c["qty"]),
                    "time": int(c["ts"] * 1000), "realizedPnl": fmt(c["pnl"], 8), "orderId": 1}
                   for c in a.closed if not sym or c["native"] == sym]
            return resp(lst)
        if path == "/fapi/v1/income":
            return resp([])
        return None

    # ══════════════════════════ OKX v5 ══════════════════════════
    def okx(self, method, host, path, q, body, hl, raw_qs, raw_body, url):
        inst = self.inst["okx"]

        def ok(data):
            return resp({"code": "0", "msg": "", "data": data})

        def err(code, msg, data=None):
            return resp({"code": str(code), "msg": msg, "data": data if data is not None else []})
        if path == "/api/v5/public/time":
            return ok([{"ts": str(self.ms())}])
        if path == "/api/v5/public/instruments":
            return ok([{"instType": "SWAP", "instId": n, "ctType": "linear", "ctValCcy": n.split("-")[0], "ctVal": fmt(i.get("ct_val", 1)),
                        "lotSz": fmt(i.get("lot_sz", 1)), "tickSz": fmt(i["tick"]), "minSz": fmt(i.get("lot_sz", 1)),
                        "lever": fmt(i.get("max_lev", 100)), "state": "live" if i.get("status", "Trading") == "Trading" else "suspend",
                        "settleCcy": "USDT"} for n, i in inst.items() if not q.get("instId") or q.get("instId") == n])
        if path == "/api/v5/market/ticker":
            p = self.price("okx", q.get("instId"))
            if p is None:
                return err(51001, "Instrument ID doesn't exist.")
            i = inst[q.get("instId")]
            sp = i.get("spread", 1) * i["tick"]
            return ok([{"instId": q.get("instId"), "last": fmt(p), "bidPx": fmt(p - sp / 2), "askPx": fmt(p + sp / 2)}])
        a = self._account("okx", hl)
        if a is None:
            return err(50111, "Invalid OK-ACCESS-KEY")
        if hl.get("ok-access-passphrase") != a.passphrase:
            return err(50105, "Your OK-ACCESS-PASSPHRASE is incorrect.")
        if self._sig_ok("okx", method, path, raw_qs, raw_body, hl) is False:
            return err(50113, "Invalid Sign")

        def ctv(n):
            return (inst.get(n) or {}).get("ct_val", 1)

        def prow(n, side, p):
            mp = self.price("okx", n) or p["entry"]
            return {"instId": n, "posSide": side.lower(), "pos": fmt(p["size"] / ctv(n)), "avgPx": fmt(p["entry"]), "markPx": fmt(mp),
                    "upl": fmt((mp - p["entry"]) * p["size"] * (1 if side == "LONG" else -1), 6), "lever": str(int(a.leverage.get(n, 10))),
                    "liqPx": "", "mgnMode": "cross", "cTime": str(int(p["ts"] * 1000))}

        def order_from(b, cond):
            n = b.get("instId")
            side = str(b.get("side") or "").upper()
            ps = str(b.get("posSide")).upper() if b.get("posSide") else None
            reducing = bool(b.get("reduceOnly")) or cond
            if not ps:
                self.lenient.append(["okx", path, f"no posSide ({b.get('ordType') or 'algo'}{', reduceOnly' if reducing else ''})"])
                ps = ("LONG" if side == "SELL" else "SHORT") if reducing else ("LONG" if side == "BUY" else "SHORT")
            return {"native": n, "side": side, "pos_side": ps, "qty": float(b.get("sz") or 0) * ctv(n), "reduce": reducing}
        if path == "/api/v5/account/config":
            return ok([{"uid": "1", "acctLv": "2", "posMode": "long_short_mode", "perm": a.perms or "read_only,trade", "label": "autotrade"}])
        if path == "/api/v5/account/balance":
            av = a.balance if a.avail is None else a.avail
            return ok([{"totalEq": fmt(a.balance, 4), "upl": "0", "details": [{"ccy": "USDT", "eq": fmt(a.balance, 4),
                                                                               "cashBal": fmt(a.balance, 4), "availBal": fmt(av, 4),
                                                                               "availEq": fmt(av, 4)}]}])
        if path == "/api/v5/account/set-leverage":
            n = body.get("instId")
            i = inst.get(n) or {}
            if float(body.get("lever") or 0) > i.get("max_lev", 100):
                return err(51000, "Parameter lever error")
            a.leverage[n] = float(body.get("lever") or 0)
            return ok([{"instId": n, "lever": str(body.get("lever")), "mgnMode": body.get("mgnMode") or "cross", "posSide": ""}])
        if path == "/api/v5/trade/order" and method == "POST":
            o = order_from(body, False)
            i = inst.get(o["native"])
            if not i:
                return err(51001, "Instrument ID doesn't exist.")
            if i.get("status", "Trading") != "Trading":
                return err(1, "All operations failed", [{"ordId": "", "sCode": "51015", "sMsg": "Instrument ID does not match underlying index"}])
            sz = float(body.get("sz") or 0)
            if sz <= 0 or abs(sz / i.get("lot_sz", 1) - round(sz / i.get("lot_sz", 1))) > 1e-6:
                return err(1, "All operations failed", [{"ordId": "", "sCode": "51121", "sMsg": "Order quantity must be a multiple of the lot size."}])
            if body.get("clOrdId") and body["clOrdId"] in getattr(a, "_links", set()):
                return err(1, "All operations failed", [{"ordId": "", "sCode": "51016", "sMsg": "Duplicated clOrdId"}])
            if not o["reduce"]:
                need = o["qty"] * i["price"] / max(1.0, a.leverage.get(o["native"], 10))
                if need > (a.balance if a.avail is None else a.avail):
                    return err(1, "All operations failed", [{"ordId": "", "sCode": "51008",
                                                             "sMsg": "Order failed. Insufficient USDT margin in account"}])
            r = self.place(a, dict(o, type="MARKET" if body.get("ordType") == "market" else "LIMIT", price=float(body.get("px") or 0),
                                   trigger=0.0, cid=body.get("clOrdId") or ""))
            if not r["ok"]:
                return err(1, "All operations failed", [{"ordId": "", "sCode": "51169",
                                                         "sMsg": "Order failed because you don't have any positions in this direction for this contract to reduce or close."}])
            if body.get("clOrdId"):
                a.__dict__.setdefault("_links", set()).add(body["clOrdId"])
                # GET /api/v5/trade/order?clOrdId= ([OKX-ENTRY-TIMEOUT])
                a.__dict__.setdefault("_cid_orders", {})[body["clOrdId"]] = {
                    "ordId": str(r["id"]), "clOrdId": body["clOrdId"], "instId": o["native"],
                    "state": "filled" if r["filled"] else "live", "accFillSz": fmt(sz) if r["filled"] else "0",
                    "attachAlgoOrds": [{k: att.get(k, "") for k in ("attachAlgoClOrdId", "slTriggerPx", "tpTriggerPx")}
                                       for att in (body.get("attachAlgoOrds") or [])]}
            if r["filled"] and not o["reduce"]:
                for att in body.get("attachAlgoOrds") or []:
                    close_side = "SELL" if o["side"] == "BUY" else "BUY"
                    sz = o["qty"] if att.get("sz") is None else float(att["sz"]) * ctv(o["native"])
                    if att.get("slTriggerPx"):
                        a.orders.append({"id": self.new_id(), "native": o["native"], "side": close_side, "pos_side": o["pos_side"], "type": "STOP",
                                         "qty": sz, "trigger": float(att["slTriggerPx"]), "reduce": True, "cond": True, "algo": True, "ts": self.now(),
                                         "price": 0.0, "cid": att.get("attachAlgoClOrdId") or ""})
                    if att.get("tpTriggerPx"):
                        a.orders.append({"id": self.new_id(), "native": o["native"], "side": close_side, "pos_side": o["pos_side"], "type": "TP",
                                         "qty": sz, "trigger": float(att["tpTriggerPx"]), "reduce": True, "cond": True, "algo": True, "ts": self.now(),
                                         "price": 0.0, "cid": att.get("attachAlgoClOrdId") or ""})
            return ok([{"ordId": str(r["id"]), "clOrdId": body.get("clOrdId") or "", "tag": "", "sCode": "0", "sMsg": "Order placed"}])
        if path == "/api/v5/trade/order" and method == "GET":   # order details by clOrdId
            cid = q.get("clOrdId") or ""
            rec = (getattr(a, "_cid_orders", {}) or {}).get(cid) if cid else None
            if not rec or rec["instId"] != q.get("instId"):
                return err(51603, "Order does not exist")
            return ok([dict(rec)])
        if path == "/api/v5/trade/order-algo":
            o = order_from(body, True)
            cur = self.pos(a, o["native"], o["pos_side"])
            if not cur:
                return err(1, "Operation failed", [{"algoId": "", "sCode": "51169", "sMsg": "no position"}])
            close_all = str(body.get("closeFraction") or "") == "1"
            oid = self.new_id()
            a.orders.append({"id": oid, "native": o["native"], "side": o["side"], "pos_side": o["pos_side"],
                             "type": "STOP" if body.get("slTriggerPx") else "TP", "qty": cur["size"] if close_all else o["qty"],
                             "trigger": float(body.get("slTriggerPx") or body.get("tpTriggerPx") or 0), "reduce": True, "cond": True,
                             "algo": True, "ts": self.now(), "price": 0.0, "cid": "", "close_all": close_all})
            return ok([{"algoId": str(oid), "sCode": "0", "sMsg": ""}])
        if path == "/api/v5/account/positions":
            iid = q.get("instId")
            return ok([prow(n, s, p) for n, s, p in self.all_positions(a) if not iid or n == iid])
        if path == "/api/v5/trade/close-position":
            n = body.get("instId")
            side = str(body.get("posSide") or "").upper()
            if side not in ("LONG", "SHORT") or not self.pos(a, n, side):
                return err(51023, "Position does not exist")
            self.reduce(a, n, side, self.pos(a, n, side)["size"])
            return ok([{"instId": n, "posSide": body.get("posSide")}])
        if path == "/api/v5/trade/orders-pending":
            return ok([{"ordId": str(o["id"]), "instId": o["native"], "side": o["side"].lower(), "posSide": o["pos_side"].lower(),
                        "ordType": "market" if o["type"] == "MARKET" else "limit", "px": fmt(o.get("price") or 0),
                        "sz": fmt(o["qty"] / ctv(o["native"])), "reduceOnly": str(bool(o["reduce"])).lower(),
                        "cTime": str(int(o["ts"] * 1000))} for o in a.orders if not o.get("algo")
                       and (not q.get("instId") or o["native"] == q.get("instId"))])
        if path == "/api/v5/trade/cancel-order":
            n = len(a.orders)
            a.orders = [o for o in a.orders if str(o["id"]) != str(body.get("ordId"))]
            if n == len(a.orders):
                return err(1, "failed", [{"ordId": body.get("ordId"), "sCode": "51400", "sMsg": "Order cancellation failed"}])
            return ok([{"ordId": body.get("ordId"), "sCode": "0", "sMsg": ""}])
        if path == "/api/v5/trade/orders-algo-pending":
            return ok([{"algoId": str(o["id"]), "instId": o["native"], "side": o["side"].lower(), "posSide": o["pos_side"].lower(),
                        "ordType": "conditional", "slTriggerPx": fmt(o["trigger"]) if o["type"] == "STOP" else "",
                        "tpTriggerPx": fmt(o["trigger"]) if o["type"] == "TP" else "",
                        "sz": "" if o.get("close_all") else fmt(o["qty"] / ctv(o["native"])),
                        "closeFraction": "1" if o.get("close_all") else ""}
                       for o in a.orders if o.get("algo") and (not q.get("instId") or o["native"] == q.get("instId"))])
        if path == "/api/v5/trade/cancel-algos":
            ids = {str(x.get("algoId")) for x in (body if isinstance(body, list) else [])}
            a.orders = [o for o in a.orders if not (o.get("algo") and str(o["id"]) in ids)]
            return ok([{"algoId": i, "sCode": "0", "sMsg": ""} for i in sorted(ids)])
        if path == "/api/v5/account/positions-history":
            iid = q.get("instId")
            lst = [{"instId": c["native"], "direction": c["side"].lower(), "posSide": c["side"].lower(), "uTime": str(int(c["ts"] * 1000)),
                    "closeAvgPx": fmt(c["exit"]), "openAvgPx": fmt(c["entry"]), "closeTotalPos": fmt(c["qty"] / ctv(c["native"])),
                    "realizedPnl": fmt(c["pnl"], 6), "pnl": fmt(c["pnl"], 6), "clOrdId": ""}
                   for c in reversed(a.closed) if not iid or c["native"] == iid]
            return ok(lst)
        return None

    # ── state snapshot (fixture) ──
    def snapshot(self):
        out = {}
        for (ex, key), a in sorted(self.accounts.items()):
            out[f"{ex}|{key}"] = {
                "balance": a.balance, "hedge": a.hedge, "leverage": dict(sorted(a.leverage.items())),
                "positions": [[n, s, {k: (round(v, 10) if isinstance(v, float) else v) for k, v in p.items() if k != "ts"}]
                              for n, s, p in self.all_positions(a)],
                "orders": [{k: v for k, v in o.items() if k not in ("ts",)} for o in a.orders],
                "closed": len(a.closed),
            }
        return out
