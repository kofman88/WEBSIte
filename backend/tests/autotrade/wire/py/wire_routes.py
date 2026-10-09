"""wire_routes.py — the route half of the wire differential (drive_wire_diff.py WIRE_MODE=routes).

The bot's own Mini App handlers (miniapp_api.h_exchange_keys / h_exchange_keys_remove / h_positions)
and Telegram trade buttons (handlers/trading.py exec_trade, handlers/quick_close.py cb_qc_half /
cb_qc_full / cb_qc_full_force / cb_holdlock_wait / cb_qc_be / cb_qc_refresh) run step by step over
the STATEFUL fake exchanges (fake_exchanges.py) on the driver's virtual-time loop: one simulator per
session (a user on one exchange: connect the key, read positions, open the confirm-mode trade under
an error class, quick-close / SL→BE / progress a position that exists on the exchange, remove the
key), every request recorded per task with the answer it got, the handler log lines, the trader log
markers, and after each step the user row, the trade row and the simulator state.

For every key the bot accepted, the step also carries the exchange's answer to the D15 permission
read the site makes after the test call (decision D15: the bot never asks) — produced with the
bot's own signing code against the same simulator state (`d15`).

Runs inside drive_wire_diff.py (`__main__`): it reuses its loop, clock, recording and fakes.
"""
from __future__ import annotations

import asyncio
import copy
import json
import random as _random
import sqlite3

import __main__ as D  # drive_wire_diff.py

import miniapp_api as api  # noqa: E402
import handlers.trading as h_trading  # noqa: E402
import handlers.quick_close as h_qc  # noqa: E402
import handlers._common as h_common  # noqa: E402
import quick_close  # noqa: E402
from aiohttp import web  # noqa: E402
from user_manager import UserManager  # noqa: E402

FX = D.FX
ROUTE_LOGGERS = {"CHM.MiniApp", "CHM.Handlers.trading", "CHM.Handlers.QuickClose", "CHM.QuickClose", "CHM.Handlers"}
B = "/miniapp/api"
TRADE_COLS = ["trade_id", "user_id", "symbol", "direction", "entry", "sl", "tp1", "tp2", "tp3", "created_at", "strategy",
              "breakout_type", "timeframe", "result", "result_rr", "order_id", "pos_idx", "tp_placed", "be_set", "qty",
              "entry_lo", "entry_hi", "exchange", "state", "original_sl"]
USER_FIELDS = ["bybit_api_key", "bybit_api_secret", "bingx_api_key", "bingx_api_secret", "binance_api_key", "binance_api_secret",
               "okx_api_key", "okx_api_secret", "okx_passphrase", "bybit_demo", "trade_exchange", "auto_trade"]
TRADE_SNAP = ["order_id", "pos_idx", "qty", "tp_placed", "be_set", "result", "state"]
D15_PATH = {"bybit": "/v5/user/query-api", "bingx": "/openApi/v1/account/apiPermissions",
            "binance": "/sapi/v1/account/apiRestrictions", "okx": "/api/v5/account/config"}


# ── fakes of the bot's request / callback objects ────────────────────────────
class FakeReq:
    """What the three handlers read of an aiohttp request: method, headers, json()."""

    def __init__(self, method, path, uid, body):
        self.method = method
        self.path = path
        self.headers = {"X-Test-Uid": str(uid)} if uid is not None else {}
        self._body = body

    async def text(self):
        return self._body or ""

    async def read(self):
        return (self._body or "").encode()

    async def json(self, *, loads=json.loads):
        return loads(self._body or "")


def _tg_user(request):
    v = request.headers.get("X-Test-Uid", "")
    return {"id": int(v), "username": f"user{v}", "first_name": "T", "language_code": "ru"} if v else None


api._tg_user = _tg_user


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


# ── scenario generation ──────────────────────────────────────────────────────
ROUTE_SCENARIOS: list = []
QC_ROUTE = {"cb_qc_half": "qc_half_", "cb_qc_full": "qc_full_", "cb_qc_full_force": "qc_full_force_", "cb_qc_be": "qc_be_",
            "cb_qc_refresh": "qc_refresh_"}
CLOSE_PATH = {"bybit": ("POST", "/v5/order/create"), "bingx": ("POST", "/openApi/swap/v2/trade/order"),
              "binance": ("POST", "/fapi/v1/order"), "okx": ("POST", "/api/v5/trade/close-position")}
BE_PATH = {"bybit": ("POST", "/v5/position/trading-stop"), "bingx": ("POST", "/openApi/swap/v2/trade/order"),
           "binance": ("POST", "/fapi/v1/order"), "okx": ("POST", "/api/v5/trade/order-algo")}
TEST_PATH = {"bybit": ("GET", "/v5/account/wallet-balance"), "bingx": ("GET", "/openApi/swap/v2/user/balance"),
             "binance": ("GET", "/fapi/v2/balance"), "okx": ("GET", "/api/v5/account/balance")}
DASH_PATH = {"bybit": ("GET", "/v5/position/list"), "bingx": ("GET", "/openApi/swap/v2/user/positions"),
             "binance": ("GET", "/fapi/v2/positionRisk"), "okx": ("GET", "/api/v5/account/positions")}
BAD_KEY = {"bybit": {"retCode": 10003, "retMsg": "API key is invalid.", "result": {}, "retExtInfo": {}, "time": 1767781800000},
           "bingx": {"code": 100413, "msg": "Incorrect apiKey", "data": {}},
           "binance": {"code": -2015, "msg": "Invalid API-key, IP, or permissions for action."},
           "okx": {"code": "50111", "msg": "Invalid OK-ACCESS-KEY", "data": []}}
RATE = {"bybit": ({"retCode": 10006, "retMsg": "Too many visits!", "result": {}, "retExtInfo": {}, "time": 1767781800000}, 200),
        "bingx": ({"code": 100410, "msg": "rate limit exceeded", "data": {}}, 429),
        "binance": ({"code": -1003, "msg": "Too many requests"}, 429),
        "okx": ({"code": "50011", "msg": "Too Many Requests", "data": []}, 429)}
PERMS = {
    "bybit": {"withdraw": {"ContractTrade": ["Order", "Position"], "Wallet": ["AccountTransfer", "Withdraw"]}},
    "bingx": {"withdraw": [1, 3, 5]},
    "binance": {"withdraw": {"withdraw": True}},
    "okx": {"withdraw": "read_only,trade,withdraw"},
}
PERM_UNREADABLE = {
    "bybit": {"json": {"retCode": 10005, "retMsg": "Permission denied, please check your API key permissions.", "result": {}}},
    "bingx": {"json": {"code": 100001, "msg": "Signature verification failed", "data": {}}},
    "binance": {"status": 401, "json": {"code": -2015, "msg": "Invalid API-key, IP, or permissions for action."}},
    "okx": {"json": {"code": "50113", "msg": "Invalid Sign", "data": []}},
}
EXEC_CLASSES = ["insufficient_margin", "precision", "rate_limit", "duplicate", "position_mode", "delisted",
                "timeout_after_accept", "timeout_before_accept", "html_502", "connect"]


def _f(ex, mp, kind="resp", nth=1, **kw):
    m, p = mp
    return dict({"ex": ex, "method": m, "path": p, "nth": nth, "kind": kind}, **kw)


def gen_routes(seed, per_ex):
    rng = _random.Random(seed)
    uid = 9100
    for ex in ("bybit", "bingx", "binance", "okx"):
        for k in range(per_ex):
            uid += 1
            lang = rng.choice(["ru", "ru", "en"])
            key, sec, pp = (s.format(uid=uid) for s in D.KEYS[ex])
            sym = rng.choice(["SOL-USDT-SWAP", "ETH-USDT-SWAP", "BTC-USDT-SWAP", "PEPE-USDT-SWAP"])
            qc_sym = "XRP-USDT-SWAP" if sym != "XRP-USDT-SWAP" else "DOGE-USDT-SWAP"
            T0 = D.T0
            demo = ex == "bybit" and rng.random() < 0.25
            user = {"sub_plan": "pro", "sub_status": "active", "sub_expires": T0 + 30 * 86400, "lang": lang,
                    "trade_exchange": ex, "auto_trade": True, "auto_trade_mode": "confirm", "bybit_demo": demo,
                    "trade_risk_pct": rng.choice([0.5, 1.0, 2.0]), "trade_leverage": rng.choice([5, 10, 20]),
                    "max_trades_limit": rng.choice([0, 5, 5, 5]),
                    "hold_lock_enabled": rng.random() < 0.3, "hold_lock_min_rr": rng.choice([0.0, 0.5, 1.0])}
            acct = {"ex": ex, "key": key, "secret": sec, "passphrase": pp, "balance": rng.choice([1000.0, 250.0, 40.0]),
                    "hedge": None, "avail": None, "perms": None, "bybit_host": None, "positions": []}
            faults = []
            steps = []
            # sessions 0-9: one exec error class each, 10-11: a clean exec, 12+: the D15 refusals (withdraw / unreadable)
            perm = ["withdraw", "unreadable"][k % 2] if k >= 12 else "ok"
            rng.random()
            if perm == "withdraw":
                acct["perms"] = PERMS[ex]["withdraw"]
            elif perm == "unreadable":
                faults.append(dict(_f(ex, ("GET", D15_PATH[ex]), nth="all", label="d15_unreadable"), **PERM_UNREADABLE[ex]))
            if ex == "bybit":
                acct["bybit_host"] = rng.choice([None, None, "live", "demo"])
            prestored = rng.random() < 0.3 and k < 12
            body = {"exchange": rng.choice([ex, f" {ex.upper()} "]), "api_key": f"  {key} ", "api_secret": sec}
            if ex == "okx":
                body["passphrase"] = pp
            # 1. the key: a wrong secret first (sometimes), then the real one under a test-call fault
            if not prestored:
                if rng.random() < 0.35:
                    bad = dict(body, api_secret=sec[::-1])
                    steps.append({"name": "keys bad secret", "kind": "http", "method": "POST", "path": B + "/exchange/keys",
                                  "body": json.dumps(bad), "dt": 31.0})
                tf = rng.choice(["none", "none", "none", "rate", "502", "hang", "connect", "badkey"])
                n_prev = sum(1 for s in steps if s["name"] == "keys bad secret")
                nth = (2 if ex == "bybit" else 1) * n_prev + 1 if tf != "hang" else "all"
                if tf == "rate":
                    j, st = RATE[ex]
                    faults.append(_f(ex, TEST_PATH[ex], nth=nth, json=j, status=st, label="test_rate"))
                elif tf == "502":
                    faults.append(_f(ex, TEST_PATH[ex], kind="status", nth=nth, status=502, label="test_502"))
                elif tf == "hang":
                    faults.append(_f(ex, TEST_PATH[ex], kind="hang", nth=nth, label="test_hang"))
                elif tf == "connect":
                    faults.append(_f(ex, TEST_PATH[ex], kind="connect", nth=nth, label="test_connect"))
                elif tf == "badkey":
                    faults.append(_f(ex, TEST_PATH[ex], nth=nth, json=BAD_KEY[ex], status=401 if ex == "binance" else 200,
                                     label="test_badkey"))
                steps.append({"name": f"keys connect ({tf}, perm {perm})", "kind": "http", "method": "POST", "path": B + "/exchange/keys",
                              "body": json.dumps(body), "dt": 31.0})
                if perm != "ok":
                    # D15: the site refuses this key (the bot stores it) — the two worlds part here
                    ROUTE_SCENARIOS.append({
                        "name": f"route_{ex}_{k:02d}", "uid": uid, "exchange": ex, "clock": T0, "user": user, "stored_keys": {},
                        "accounts": [acct], "instruments": D.build_instruments(None), "faults": faults, "moves": [], "trades": [],
                        "candles": {}, "steps": steps, "perm": perm,
                    })
                    continue
            # positions on the exchange before the trades: the quick-close target + maybe another one
            insts = D.build_instruments(None)
            qpx = D.COINS[qc_sym]["price"]
            qdir = rng.choice(["LONG", "SHORT"])
            q_native = D._native(ex, qc_sym)[0]
            qty = {"bybit": 120.0, "bingx": 120.0, "binance": 120.0, "okx": 12.0}[ex]
            if rng.random() < 0.85:
                acct["positions"].append([q_native, qdir, qty, insts[ex][q_native]["price"]])
            if rng.random() < 0.4:
                l_native = D._native(ex, "LINK-USDT-SWAP")[0]
                acct["positions"].append([l_native, rng.choice(["LONG", "SHORT"]), 3.0, insts[ex][l_native]["price"]])
            # 2. positions (± a dashboard fault)
            pf = rng.choice(["none", "none", "hang", "502"])
            if pf == "hang":
                faults.append(_f(ex, DASH_PATH[ex], kind="hang", nth=1, label="dash_hang"))
            elif pf == "502":
                faults.append(_f(ex, DASH_PATH[ex], kind="status", nth=1, status=502, label="dash_502"))
            steps.append({"name": f"positions ({pf})", "kind": "http", "method": "GET", "path": B + "/positions", "body": None, "dt": 61.0})
            # 3. the confirm-mode exec under an error class
            direction = rng.choice(["LONG", "SHORT"])
            sig = D.make_signal(rng, sym, direction, "LEVELS", price=D.COINS[sym]["price"], drift=0.0, sl_pct=rng.choice([0.008, 0.012, 0.02]))
            is_split = ex == "bybit" and rng.random() < 0.3
            ecls = (EXEC_CLASSES + ["none", "none"])[k] if k < 12 else "none"
            rng.random()
            if ecls != "none":
                faults.append(D.fault(ex, ecls, nth=1))
            trades = []
            t_exec = {"trade_id": f"X{uid}", "user_id": uid, "symbol": sym, "direction": direction, "entry": sig["entry"],
                      "sl": sig["sl"], "tp1": sig["tp1"], "tp2": sig["tp2"], "tp3": sig["tp3"], "created_at": T0 - 600,
                      "strategy": "SMC" if is_split else "LEVELS", "breakout_type": "SMC" if is_split else "", "timeframe": "1h",
                      "result": "", "result_rr": 0.0, "order_id": "", "pos_idx": 0, "tp_placed": 0, "be_set": 0, "qty": 0.0,
                      "entry_lo": sig["entry"] * 0.999 if is_split else 0.0, "entry_hi": sig["entry"] * 1.001 if is_split else 0.0,
                      "exchange": ex, "state": "PENDING", "original_sl": sig["sl"], "_card": "exec"}
            trades.append(t_exec)
            steps.append({"name": f"exec ({ecls}{', split' if is_split else ''})", "kind": "cb", "handler": "exec_trade",
                          "data": f"exec_trade_{t_exec['trade_id']}", "tid": t_exec["trade_id"], "dt": 7.0})
            # 4. quick close / BE / progress on the position that exists
            qsl = qpx * (0.98 if qdir == "LONG" else 1.02)
            qtp = qpx * (1.03 if qdir == "LONG" else 0.97)
            t_qc = {"trade_id": f"Q{uid}", "user_id": uid, "symbol": qc_sym, "direction": qdir, "entry": qpx * rng.choice([0.995, 1.0, 1.004]),
                    "sl": qsl, "tp1": qtp, "tp2": 0.0, "tp3": 0.0, "created_at": T0 - 3 * 3600, "strategy": "LEVELS",
                    "breakout_type": "", "timeframe": "1h", "result": "", "result_rr": 0.0, "order_id": f"ord-{uid}",
                    "pos_idx": (1 if qdir == "LONG" else 2) if ex == "bybit" and rng.random() < 0.3 else 0, "tp_placed": 1,
                    "be_set": 0, "qty": qty, "entry_lo": 0.0, "entry_hi": 0.0, "exchange": rng.choice([ex, ex, ex, ""]),
                    "state": "OPEN", "original_sl": qsl, "_card": "qc"}
            trades.append(t_qc)
            seq = rng.choice([["cb_qc_half", "cb_qc_full"], ["cb_qc_be", "cb_qc_full"], ["cb_qc_full"], ["cb_qc_refresh", "cb_qc_half"],
                              ["cb_qc_full", "cb_qc_full_force"], ["cb_qc_be"], ["cb_holdlock_wait", "cb_qc_full_force"]])
            qf = rng.choice(["none", "none", "rate", "pos_hang", "reject", "502"])
            if qf == "rate":
                j, st = RATE[ex]
                faults.append(_f(ex, CLOSE_PATH[ex], nth=1, json=j, status=st, label="qc_rate"))
            elif qf == "pos_hang":
                faults.append(_f(ex, DASH_PATH[ex], kind="hang", nth=2 if pf == "hang" else 1, label="qc_pos_hang"))
            elif qf == "reject":
                faults.append(_f(ex, BE_PATH[ex] if seq[0] == "cb_qc_be" else CLOSE_PATH[ex], nth=1,
                                 **{k2: v for k2, v in zip(("json", "status"), (D.ERRORS[ex]["precision"][2]["json"],
                                                                               D.ERRORS[ex]["precision"][2].get("status", 200)))},
                                 label="qc_reject"))
            elif qf == "502":
                faults.append(_f(ex, CLOSE_PATH[ex], kind="status", nth=1, status=502, label="qc_502"))
            for h in seq:
                if h == "cb_holdlock_wait":
                    steps.append({"name": "qc wait", "kind": "cb", "handler": h, "data": "qc_holdlock_wait", "tid": t_qc["trade_id"], "dt": 5.0})
                else:
                    steps.append({"name": f"{h} ({qf})", "kind": "cb", "handler": h, "data": QC_ROUTE[h] + t_qc["trade_id"],
                                  "tid": t_qc["trade_id"], "dt": 5.0})
            # 5. positions again, then (sometimes) the key goes
            steps.append({"name": "positions after", "kind": "http", "method": "GET", "path": B + "/positions", "body": None, "dt": 61.0})
            if rng.random() < 0.5:
                steps.append({"name": "remove", "kind": "http", "method": "POST", "path": B + "/exchange/keys/remove",
                              "body": json.dumps({"exchange": ex}), "dt": 5.0})
            # price path for the progress card / hold lock (5m candles of the quick-close symbol)
            bars = D.bars_series(int((T0 - 3600) * 1000) // 300_000 * 300_000, 12, qpx, qpx * rng.choice([-0.001, 0.0, 0.0012]),
                                 tf_ms=300_000, seed=uid)
            ROUTE_SCENARIOS.append({
                "name": f"route_{ex}_{k:02d}", "uid": uid, "exchange": ex, "clock": T0, "user": user,
                "stored_keys": {ex: [key, sec, pp]} if prestored else {}, "accounts": [acct],
                "instruments": D.build_instruments(None), "faults": faults, "moves": [], "trades": trades,
                "candles": {f"{qc_sym}|5m": bars}, "steps": steps, "perm": perm,
            })


# ── running ──────────────────────────────────────────────────────────────────
async def seed_route(c, um):
    con = D.db_conn()
    for t in ("users", "trades", "kv", "trade_events", "bybit_account_mode"):
        con.execute(f"DELETE FROM {t}")
    con.execute("UPDATE operational_state SET state='ACTIVE', reason='' WHERE id=1")
    con.commit()
    con.close()
    uid = c["uid"]
    u = await um.get_or_create(uid, f"user{uid}", "ru")
    for k, v in c["user"].items():
        setattr(u, k, v)
    for ex, (key, sec, pp) in c["stored_keys"].items():
        setattr(u, f"{ex}_api_key", key)
        setattr(u, f"{ex}_api_secret", sec)
        if ex == "okx":
            u.okx_passphrase = pp
    await um.save(u)
    con = D.db_conn()
    for r in c["trades"]:
        cols = [k for k in TRADE_COLS if k in r]
        con.execute(f"INSERT INTO trades ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", [r[k] for k in cols])
    con.commit()
    con.close()


async def user_snapshot(um, uid):
    um_fresh = UserManager()
    u = await um_fresh.get(uid)
    return None if u is None else {f: D.jsonable(getattr(u, f)) for f in USER_FIELDS}


def trade_snapshot(tid):
    con = sqlite3.connect(D.DBP)
    row = con.execute(f"SELECT {', '.join(TRADE_SNAP)} FROM trades WHERE trade_id=?", (tid,)).fetchone()
    con.close()
    return None if row is None else dict(zip(TRADE_SNAP, row))


async def d15_answer(ex, key, sec, pp, demo):
    """The permission read the site makes after a successful test call, signed by the bot's own code."""
    D.RECS.clear()
    D.CAPTURE[0] = True
    try:
        if ex == "bybit":
            s = D.by._get_session(key, sec, demo=demo)
            try:
                s.get_api_key_information()
            except Exception:  # noqa: BLE001 — pybit raises on retCode != 0; the answer is recorded
                pass
        elif ex == "bingx":
            await D.bx._request("GET", "/openApi/v1/account/apiPermissions", key, sec)
        elif ex == "binance":
            qs, headers = D.bn._build_query(key, sec, {})
            url = f"https://api.binance.com/sapi/v1/account/apiRestrictions?{qs}"
            fake = await D.bn._get_http_session()
            async with fake.get(D.yarl.URL(url, encoded=True), headers=headers) as r:
                await r.text()
        else:
            await D.ok._request("GET", "/api/v5/account/config", key, sec, pp)
    finally:
        D.CAPTURE[0] = False
    reqs = [r[2] for r in D.RECS if r[1] == "req"]
    D.RECS.clear()
    return reqs[-1] if reqs else None


async def run_route_case(c):
    D.reset_module_state()
    api._RATE.clear()
    h_common._exec_trade_locks.clear()
    D.CASE.clear()
    D.CASE.update(c)
    D.CLK.wall = float(c["clock"])
    sim = FX.Sim(now=lambda: D.CLK.wall, instruments=copy.deepcopy(c["instruments"]), faults=copy.deepcopy(c["faults"]))
    for a in c["accounts"]:
        acc = sim.add_account(a["ex"], a["key"], a["secret"], passphrase=a["passphrase"], balance=a["balance"], hedge=a["hedge"],
                              avail=a["avail"], perms=a.get("perms"), bybit_host=a.get("bybit_host"))
        for native, side, qty, px in a.get("positions") or []:
            sim.open(acc, native, side, qty, px)
    D.SIM[0] = sim
    um = UserManager()
    await seed_route(c, um)
    api._ctx.update(bot=None, um=um, scanner=None)
    dp = _DP()
    h_trading.register_handlers(dp, None, um, None, None)
    h_qc.register_handlers(dp, None, um, None, None)
    loop = asyncio.get_running_loop()
    out = []
    D.LOG_ALLOW[0] = ROUTE_LOGGERS
    for s in c["steps"]:
        await asyncio.sleep(s.get("dt", 0.0))
        api._RATE.clear()
        rec = {"name": s["name"], "now": D.CLK.wall}
        before = set(asyncio.all_tasks())
        D.RECS.clear()
        D.CAPTURE[0] = True

        async def _step():
            if s["kind"] == "http":
                fn = {"/exchange/keys": api.h_exchange_keys, "/exchange/keys/remove": api.h_exchange_keys_remove,
                      "/positions": api.h_positions}[s["path"][len(B):]]
                try:
                    resp = await fn(FakeReq(s["method"], s["path"], c["uid"], s["body"]))
                except web.HTTPException as e:
                    resp = e
                rec.update({"status": resp.status, "ctype": resp.content_type, "text": resp.text})
            else:
                cb = _CB(s["data"], c["uid"])
                try:
                    await dp.handlers[s["handler"]](cb)
                    rec["raised"] = None
                except Exception as e:  # noqa: BLE001
                    rec["raised"] = f"{type(e).__name__}: {e}"
                rec["effects"] = cb.effects

        await loop.create_task(_step(), name="route")
        me = asyncio.current_task()
        t_end = D.CLK.wall
        while True:
            pend = [t for t in asyncio.all_tasks() if t is not me and t not in before and not t.done()]
            if not pend:
                break
            await asyncio.wait(pend, timeout=3600)
            if D.CLK.wall - t_end > 7200:
                raise RuntimeError(f"{c['name']}: tasks pending {[t.get_name() for t in pend]}")
        await D.wait_threads_idle()
        D.CAPTURE[0] = False
        rec["recs"] = copy.deepcopy(D.RECS)
        rec["end"] = D.CLK.wall
        rec["user_after"] = await user_snapshot(um, c["uid"])
        if s.get("tid"):
            rec["trade_after"] = trade_snapshot(s["tid"])
        if s.get("handler") == "cb_qc_refresh":
            from database import db_get_trade
            tr = await db_get_trade(s["tid"])
            u = await um.get(c["uid"])
            rec["pnl"] = D.jsonable(await quick_close.get_current_pnl(u, tr)) if tr and u else None
        rec["d15"] = None
        if s["kind"] == "http" and s["path"] == B + "/exchange/keys" and rec["status"] == 200:
            try:
                body_out = json.loads(rec["text"])
            except Exception:  # noqa: BLE001
                body_out = {}
            if body_out.get("ok") is True:
                ex = body_out["exchange"]
                ua = rec["user_after"]
                rec["d15"] = await d15_answer(ex, ua[f"{ex}_api_key"], ua[f"{ex}_api_secret"], ua["okx_passphrase"],
                                              bool(ua["bybit_demo"]))
        con = D.db_conn()
        rec["events"] = [[r["trade_id"], r["event_type"], r["payload_json"]]
                         for r in con.execute("SELECT trade_id, event_type, payload_json FROM trade_events ORDER BY id")]
        con.close()
        rec["sim_after"] = D.jsonable(sim.snapshot())
        out.append(rec)
    D.LOG_ALLOW[0] = None
    D.SIM[0] = None
    return {"steps": out, "lenient": sim.lenient, "sim_errors": sim.errors}


async def main(out_path, seed, per_ex, only):
    gen_routes(seed, per_ex)
    vectors = []
    for c in ROUTE_SCENARIOS:
        if only and c["name"] not in only:
            continue
        exp = await run_route_case(c)
        vectors.append({"case": c, "expected": exp})
        nreq = sum(1 for st in exp["steps"] for r in st["recs"] if r[1] == "req")
        print(f"{c['name']}: steps={len(exp['steps'])} reqs={nreq}", file=D.sys.stderr)
    return vectors
