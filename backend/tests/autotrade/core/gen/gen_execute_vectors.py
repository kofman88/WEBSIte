"""gen_execute_vectors.py — differential vectors for auto_trade.execute_auto_trade (M13b core).

The bot's own execute_auto_trade — with everything it calls running for real (killswitch, plan
gate, cooldown / auth breakers, idempotency registry + kv, correlation cap, adaptive sizing,
trend-ctx sizing, prop pilot, AI filter + AI button, tilt detector, skip notifications, admin
alerts, the reconcile / LIMIT-unfilled helpers, i18n, telegram_safe, trade_events, a fresh bot
SQLite on a temp file) — is driven over the cases below against FAKE exchange traders: every
trader I/O function of bybit/bingx/binance/okx_trader is replaced by a recorder that binds its
arguments to the real function's signature and serves scripted responses (last one repeats):
  {"ret": v} | {"raise": msg, "type": "Exception"|"RuntimeError"|...} | {"hang": true} | {"after": s, "ret": v}
format_trade_result(_split) and the *_price_multiplier helpers stay the real ones.

Faked collaborators (recorded as `side` events, replayed identically by the JS test):
exchange_symbols.is_symbol_available / record_skip, challenge.gate, partial_tp.place_partial_tp_orders
(wire-level parity of partial TP is a separate suite), user_logger, funnel_tracker.track_once,
metrics.mutation_log.emit_mutation, metrics.sl_protection_counters.record_leverage_cap,
notification_queue.enqueue_critical, signal_filter.has_model (D11: always False), genome.
get_last_mutation_info (AI genome layer input), cache.get_candles (case candles), the Telegram bot.

Clock: a virtual-time event loop (VLoop): time.time / time.monotonic / datetime.utcnow follow one
clock that only moves when the loop is idle (it jumps to the next timer), so asyncio.wait_for
timeouts, asyncio.sleep(5) retries and the 60 s / 900 s LIMIT-unfilled grace run instantly and
deterministically; aiosqlite's worker threads are tracked so the clock never moves while a DB
call is in flight.

Every record is tagged with its logical task: the bot's named tasks (partial_tp_<uid>_<sym>,
limit_unfilled_guard_<uid>_<sym>, reconcile_sl_*, reconcile_ptp_*, tilt_detect_<uid>) or the
caller ("call<i>") for wait_for / gather helper tasks.

Batch D (bot c56653d, auto_trade.py 1bfc59c + d8123a2): the `d2_*` cases drive [VOL15-RISK-CAP] (incl.
the VOLUME 15m low-notional pause), [SAME-DIR-CAP], [MARKET-ENTRY-NO-SHIFT] and [FEE-AWARE-SIZE]; case
fields `taker_fee` ({exchange: value | "__del__"} on the trader module), `count_fail` (the direction
count of db_count_open_trades raises), `ctx_risk` (trend_monitor.CTX_RISK overlay) and state `vol15_ln`.
`helpers` = the pure helpers called directly (env parsers, cap, taker fee, fee factor, required
balance), `count_vectors` = db_count_open_trades on seeded rows.

Output: backend/tests/autotrade/core/fixtures/execute_vectors.json.gz
  cd /home/user/MAIN_BOT/CHM_BREAKER_V4
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 $PY311 -I -B <worktree>/backend/tests/autotrade/core/gen/gen_execute_vectors.py
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import asyncio
import copy
import dataclasses
import enum
import gzip
import inspect
import json
import logging
import math
import os
import queue  # noqa: F401  (imported before the clock patch: keeps the real monotonic)
import re
import selectors
import shutil
import sqlite3
import sys
import tempfile
import threading  # noqa: F401
import types

import datetime as _dt
import time as _time

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.normpath(
    os.path.join(HERE, "..", "fixtures", "execute_vectors.json.gz"))
TMP = tempfile.mkdtemp(prefix="m13b_exec_")
DBP = os.path.join(TMP, "bot.db")
os.environ["DB_PATH"] = DBP
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ["ADMIN_IDS"] = "123"
os.environ["NEWS_PROVIDER"] = "none"
# a test-only Fernet key: db_get_user refuses to run with keys in the users table otherwise
# (plaintext test values decrypt to themselves — the bot's migration path)
os.environ["BYBIT_FERNET_KEY"] = "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="
os.environ["AI_FILTER_ENABLED"] = "1"
for _k in ("LEVELS_HOUR_FILTER_ENABLED", "LEVELS_HOUR_FILTER_MODE", "LEVELS_BAD_HOURS_UTC",
           "SMC_HOUR_FILTER_ENABLED", "SMC_HOUR_FILTER_MODE", "SMC_BAD_HOURS_UTC", "DAILY_MAX_LOSS_R",
           "TREND_CTX_RISK", "SKIP_NOTIFY_THRESHOLD", "SENTRY_DSN"):
    os.environ.pop(_k, None)
sys.dont_write_bytecode = True
os.chdir(BOT)
sys.path.insert(0, BOT)

import aiosqlite  # noqa: E402
import aiosqlite.core  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402


# ── virtual clock ────────────────────────────────────────────────────────────
class VClock:
    def __init__(self):
        self.wall = 1767225600.0
        self.mono = 1000.0

    def advance(self, dt):
        if dt > 0:
            self.wall += dt
            self.mono += dt


CLK = VClock()
_REAL_TIME = _time.time
_time.time = lambda: CLK.wall
_time.monotonic = lambda: CLK.mono

_EPOCH = _dt.datetime(1970, 1, 1)


class FakeDT(_dt.datetime):
    @classmethod
    def utcnow(cls):
        return _EPOCH + _dt.timedelta(seconds=CLK.wall)

    @classmethod
    def now(cls, tz=None):
        if tz is None:
            return _EPOCH + _dt.timedelta(seconds=CLK.wall)
        return _dt.datetime.fromtimestamp(CLK.wall, tz)

    @classmethod
    def today(cls):
        return _EPOCH + _dt.timedelta(seconds=CLK.wall)


class FakeDate(_dt.date):
    @classmethod
    def today(cls):
        return (_EPOCH + _dt.timedelta(seconds=CLK.wall)).date()


DTMOD = types.ModuleType("datetime")
for _k in dir(_dt):
    if not _k.startswith("__"):
        setattr(DTMOD, _k, getattr(_dt, _k))
DTMOD.datetime = FakeDT
DTMOD.date = FakeDate


class _SwapDatetime:
    """Run a coroutine with sys.modules['datetime'] = DTMOD during each of its steps
    (for bot functions that `import datetime` locally, e.g. db_get_today_loss_rr)."""

    def __init__(self, co):
        self.co = co

    def __await__(self):
        co = self.co
        val, exc = None, None
        while True:
            saved = sys.modules["datetime"]
            sys.modules["datetime"] = DTMOD
            try:
                y = co.throw(exc) if exc is not None else co.send(val)
            except StopIteration as e:
                return e.value
            finally:
                sys.modules["datetime"] = saved
            try:
                val, exc = (yield y), None
            except BaseException as e:  # noqa: BLE001
                val, exc = None, e


def swap_dt(fn):
    async def wrapped(*a, **k):
        return await _SwapDatetime(fn(*a, **k))
    return wrapped


# ── virtual-time event loop ─────────────────────────────────────────────────
INFLIGHT = [0]
PENDING_IO: dict = {}
PARENT: dict = {}


def _track(fut, what):
    INFLIGHT[0] += 1
    PENDING_IO[id(fut)] = what

    def _done(_f):
        INFLIGHT[0] -= 1
        PENDING_IO.pop(id(fut), None)
    fut.add_done_callback(_done)


class VSelector(selectors.SelectSelector):
    def select(self, timeout=None):
        while True:
            ev = super().select(0)
            if ev or timeout == 0:
                return ev          # the loop has ready callbacks (timeout 0): never block them
            if INFLIGHT[0] > 0:
                ev = super().select(0.25)
                if ev:
                    return ev
                self._idle = getattr(self, "_idle", 0) + 1
                if self._idle % 40 == 0:
                    print(f"[vloop] waiting on {INFLIGHT[0]} in-flight: {list(PENDING_IO.values())[:3]}", file=sys.stderr)
                continue
            self._idle = 0
            if timeout is None:
                raise RuntimeError("virtual loop: idle with no timers (deadlock)")
            CLK.advance(timeout)
            return []


class VLoop(asyncio.SelectorEventLoop):
    def __init__(self):
        super().__init__(selector=VSelector())

    def time(self):
        return CLK.mono

    def create_task(self, coro, *, name=None, context=None):
        try:
            parent = asyncio.current_task(self)
        except RuntimeError:
            parent = None
        t = super().create_task(coro, name=name, context=context)
        if parent is not None:
            PARENT[t] = parent
        return t

    def run_in_executor(self, executor, func, *args):
        fut = super().run_in_executor(executor, func, *args)
        _track(fut, f"executor {func!r}")
        return fut


_orig_conn_init = aiosqlite.core.Connection.__init__


def _conn_init(self, *a, **k):
    _orig_conn_init(self, *a, **k)
    q = self._tx

    class _TxProxy:
        def put_nowait(_s, item):
            if item is not aiosqlite.core._STOP_RUNNING_SENTINEL:
                import traceback as _tb
                _track(item[0], f"sqlite {item[1]!r}"[:160] + (("\n" + "".join(_tb.format_stack(limit=12))) if os.environ.get("GEN_DEBUG") else ""))
            q.put_nowait(item)

        def get(_s, *aa, **kk):
            return q.get(*aa, **kk)

    self._tx = _TxProxy()


aiosqlite.core.Connection.__init__ = _conn_init

_DEFAULT_TASK = re.compile(r"^Task-\d+$")


def task_name():
    try:
        t = asyncio.current_task()
    except RuntimeError:
        return "main"
    while t is not None:
        n = t.get_name()
        if not _DEFAULT_TASK.match(n):
            return n
        t = PARENT.get(t)
    return "anon"


# ── recording ───────────────────────────────────────────────────────────────
RECS: list = []
CAPTURE = [False]


def jsonable(o):
    if isinstance(o, enum.Enum):
        return jsonable(o.value)
    if dataclasses.is_dataclass(o) and not isinstance(o, type):
        return {f.name: jsonable(getattr(o, f.name)) for f in dataclasses.fields(o)}
    if isinstance(o, dict):
        return {str(k): jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, set)):
        return [jsonable(x) for x in o]
    if isinstance(o, float):
        if o != o:
            return {"__float__": "nan"}
        if math.isinf(o):
            return {"__float__": "inf" if o > 0 else "-inf"}
        return o
    if isinstance(o, (str, int, bool)) or o is None:
        return o
    if isinstance(o, np.generic):
        return jsonable(o.item())
    return {"__repr__": repr(o)}


def rec(kind, data):
    if CAPTURE[0]:
        RECS.append([task_name(), kind, jsonable(data)])


class Cap(logging.Handler):
    def emit(self, r):
        if not CAPTURE[0] or r.levelno < logging.INFO:
            return
        try:
            msg = r.getMessage()
        except Exception:  # noqa: BLE001
            msg = str(r.msg)
        if msg.startswith("[TG-SAFE]"):
            return
        RECS.append([task_name(), "log", [r.levelname, msg]])


logging.getLogger().addHandler(Cap())
logging.getLogger().setLevel(logging.INFO)

# ── bot modules ─────────────────────────────────────────────────────────────
import database  # noqa: E402
import db.stats as db_stats  # noqa: E402
import auto_trade  # noqa: E402
import bybit_trader  # noqa: E402
import bingx_trader  # noqa: E402
import binance_trader  # noqa: E402
import okx_trader  # noqa: E402
import partial_tp  # noqa: E402
import cache  # noqa: E402
import exchange_symbols  # noqa: E402
import challenge  # noqa: E402
import user_logger  # noqa: E402
import funnel_tracker  # noqa: E402
import metrics.mutation_log as mutation_log  # noqa: E402
import metrics.sl_protection_counters as slpc  # noqa: E402
import notification_queue  # noqa: E402
import signal_filter  # noqa: E402
import genome  # noqa: E402
import market_regime  # noqa: E402
import skip_notify  # noqa: E402
import tilt_detector  # noqa: E402
import correlation_cap  # noqa: E402
import balance_cache  # noqa: E402
import admin_alerts  # noqa: E402
import ai_filter  # noqa: E402
import handlers.ai_insights  # noqa: E402,F401
import risk_preview  # noqa: E402,F401
import prop_pilot  # noqa: E402,F401
import adaptive_sizing  # noqa: E402,F401
import trend_monitor  # noqa: E402,F401
import telegram_safe  # noqa: E402,F401
import defense.killswitch as ks  # noqa: E402
from config import Config  # noqa: E402

TRADERS = {"bybit": bybit_trader, "bingx": bingx_trader, "binance": binance_trader, "okx": okx_trader}
TRADER_FNS = ["place_trade", "place_trade_split", "get_balance", "get_positions", "get_open_orders",
              "cancel_all_orders", "get_last_price", "set_trailing_sl", "place_sl_tp_for_position",
              "place_tp_orders", "get_funding_rate", "get_spread_pct"]
# qty as the real traders return it: str for Bybit / OKX (qty_str), float for BingX / Binance
DEFAULTS = {
    "place_trade": {"ret": {"ok": True, "order_id": "OID-1", "qty": "1.5", "pos_idx": 0, "tp_placed": True}},
    "bingx.place_trade": {"ret": {"ok": True, "order_id": "BX-1", "qty": 10.0, "pos_idx": 0, "tp_placed": True}},
    "binance.place_trade": {"ret": {"ok": True, "order_id": "BN-1", "qty": 1.25, "pos_idx": 0, "tp_placed": False}},
    "okx.place_trade": {"ret": {"ok": True, "order_id": "OK-1", "qty": "3", "pos_idx": 0, "tp_placed": True}},
    "place_trade_split": {"ret": {"ok": True, "order_id": "OID-S", "qty": "2.0", "pos_idx": 0, "tp_placed": True}},
    "get_balance": {"ret": 1000.0},
    "get_positions": {"ret": [{"symbol": "SOLUSDT", "side": "Buy", "size": 1.5, "stopLoss": 98.0}]},
    "get_open_orders": {"ret": []},
    "cancel_all_orders": {"ret": {"ok": True, "cancelled": 0}},
    "get_last_price": {"ret": 100.0},
    "set_trailing_sl": {"ret": {"ok": True}},
    "place_sl_tp_for_position": {"ret": {"ok": True, "tp_placed": True}},
    "place_tp_orders": {"ret": True},
    "get_funding_rate": {"ret": 0.0001},
    "get_spread_pct": {"ret": 0.05},
}
EXC = {"Exception": Exception, "RuntimeError": RuntimeError, "ValueError": ValueError,
       "ConnectionError": ConnectionError, "TimeoutError": asyncio.TimeoutError, "OSError": OSError}
SCRIPT: dict = {}
SIGS: dict = {}
_NODEF = {"__nodefault__": True}


def take(key, default):
    q = SCRIPT.get(key)
    if not q:
        return default
    return q.pop(0) if len(q) > 1 else q[0]


async def respond(spec):
    if spec.get("hang"):
        await asyncio.sleep(10 ** 7)
    if "after" in spec:
        await asyncio.sleep(spec["after"])
    if "raise" in spec:
        raise EXC[spec.get("type", "Exception")](spec["raise"])
    return copy.deepcopy(spec.get("ret"))


def make_fake(ex, fn, sig):
    def fake(*args, **kwargs):
        try:
            b = sig.bind(*args, **kwargs)
            b.apply_defaults()
            bound = dict(b.arguments)
        except TypeError as e:
            bound = {"__bind_error__": str(e)}
        rec("call", [ex, fn, bound])
        return respond(take(f"{ex}.{fn}", DEFAULTS.get(f"{ex}.{fn}", DEFAULTS[fn])))
    return fake


for _ex, _mod in TRADERS.items():
    for _fn in TRADER_FNS:
        _real = getattr(_mod, _fn, None)
        if _real is None:
            continue
        _sig = inspect.signature(_real)
        SIGS.setdefault(_ex, {})[_fn] = [
            [p.name, p.kind.name, jsonable(p.default) if p.default is not inspect.Parameter.empty else _NODEF]
            for p in _sig.parameters.values()
        ]
        setattr(_mod, _fn, make_fake(_ex, _fn, _sig))

CASE: dict = {}


async def fake_ptp(**kw):
    k2 = {k: ("<user>" if k == "user" else ("<bot>" if k == "bot" and v is not None else v)) for k, v in kw.items()}
    rec("side", ["partial_tp", k2])
    return await respond(take("ptp", {"ret": True}))


partial_tp.place_partial_tp_orders = fake_ptp


async def fake_gate(uid, now=None):
    rec("side", ["challenge_gate", uid])
    spec = CASE.get("challenge")
    if isinstance(spec, dict):
        raise Exception(spec["raise"])
    return spec


challenge.gate = fake_gate


def fake_is_available(exchange, symbol, *, strict=False):
    rec("side", ["symbol_check", exchange, symbol, strict])
    v = CASE.get("symbol_ok", True)
    if v == "raise":
        raise RuntimeError("symbol cache broken")
    return v


exchange_symbols.is_symbol_available = fake_is_available
exchange_symbols.record_skip = lambda exchange, symbol: rec("side", ["record_skip", exchange, symbol])
user_logger.log_trade_blocked = lambda uid, username, symbol, direction, reason: rec(
    "side", ["user_log_blocked", uid, username, symbol, direction, reason])
user_logger.log_trade_open = lambda uid, username, symbol, direction, **kw: rec(
    "side", ["user_log_open", uid, username, symbol, direction, kw])


async def fake_track_once(event_name, user_id, **tags):
    rec("side", ["funnel", event_name, user_id, tags])
    return True


funnel_tracker.track_once = fake_track_once


async def fake_emit_mutation(type_, *, actor="", target="", before="", after="", context=None):
    rec("side", ["mutation", type_, {"actor": actor, "target": target, "before": before, "after": after, "context": context}])
    return True


mutation_log.emit_mutation = fake_emit_mutation
slpc.record_leverage_cap = lambda: rec("side", ["leverage_cap"])


async def fake_enqueue(bot, user_id, text, *, parse_mode="HTML", reason=""):
    rec("side", ["enqueue", user_id, text, parse_mode, reason])
    return "q1"


notification_queue.enqueue_critical = fake_enqueue
signal_filter.has_model = lambda user_id, strategy: False
genome.get_last_mutation_info = lambda strategy, tf=None: copy.deepcopy(CASE.get("mutation_info"))


def frame_of(bars):
    if not bars:
        return None
    arr = np.array(bars, dtype=float)
    idx = pd.to_datetime(arr[:, 0].astype("int64"), unit="ms")
    df = pd.DataFrame({"open": arr[:, 1], "high": arr[:, 2], "low": arr[:, 3], "close": arr[:, 4],
                       "volume": arr[:, 5]}, index=idx)
    df.index.name = "open_time"
    return df


async def fake_get_candles(symbol, tf):
    bars = (CASE.get("candles") or {}).get(f"{symbol}|{tf}")
    return frame_of(bars)


cache.get_candles = fake_get_candles
database.db_get_today_loss_rr = swap_dt(db_stats.db_get_today_loss_rr)
_REAL_COUNT_OPEN = database.db_count_open_trades


async def _count_open_trades(user_id, exclude_trade_id="", direction=""):
    """[SAME-DIR-CAP] case `count_fail`: the direction count raises (the max_trades count stays real)."""
    if CASE.get("count_fail") and direction:
        raise Exception(CASE["count_fail"])
    return await _REAL_COUNT_OPEN(user_id, exclude_trade_id=exclude_trade_id, direction=direction)


database.db_count_open_trades = _count_open_trades
db_stats.db_get_today_loss_rr = database.db_get_today_loss_rr


class _UUID:
    def __init__(self):
        self.n = 0

    def uuid4(self):
        self.n += 1
        return types.SimpleNamespace(hex=f"{self.n:08x}" + "0" * 24)


UUIDS = _UUID()
auto_trade.uuid = UUIDS


def patch_datetime():
    for _name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None) or ""
        if not f.startswith(BOT):
            continue
        for attr, val in list(vars(mod).items()):
            if val is _dt:
                setattr(mod, attr, DTMOD)
            elif val is _dt.datetime:
                setattr(mod, attr, FakeDT)
            elif val is _dt.date:
                setattr(mod, attr, FakeDate)


patch_datetime()


def kb_rows(m):
    if m is None:
        return None
    rows = getattr(m, "inline_keyboard", None)
    if rows is None:
        return {"__repr__": repr(m)}
    return [[[b.text, b.callback_data if b.callback_data is not None else b.url] for b in row] for row in rows]


class FakeBot:
    async def send_message(self, chat_id, text, **kw):
        rec("msg", [chat_id, text, kw.get("parse_mode"), kb_rows(kw.get("reply_markup"))])
        for s in CASE.get("send_fail") or []:
            if s in text:
                raise RuntimeError("send failed")
        return types.SimpleNamespace(message_id=1, chat=types.SimpleNamespace(id=chat_id))


BOT_OBJ = FakeBot()

# ── cases ───────────────────────────────────────────────────────────────────
T0 = 1767781800.0          # 2026-01-07 10:30:00 UTC (Wednesday)
H18 = 1767781800.0 + 7.5 * 3600   # 18:00 UTC
U = 501
BASE_USER = {"user_id": U, "username": "alice", "sub_plan": "pro", "sub_status": "active", "lang": "ru",
             "auto_trade": 1, "auto_trade_mode": "auto", "trade_exchange": "bybit"}
BASE_KW = {"user_id": U, "symbol": "SOL-USDT-SWAP", "direction": "LONG", "entry": 100.0, "sl": 98.0,
           "tp1": 103.0, "tp2": 106.0, "tp3": 109.0, "trade_id": "T1", "api_key": "KEY", "api_secret": "SEC",
           "risk_pct": 1.0, "leverage": 10, "auto_trade_mode": "auto", "max_trades": 5, "bot": True,
           "strategy": "LEVELS", "exchange": "bybit", "bybit_demo": False, "order_type": "Limit",
           "quality": 4, "trend_ctx": ""}


def trade_row(tid, created, **o):
    r = {"trade_id": tid, "user_id": U, "symbol": "SOL-USDT-SWAP", "direction": "LONG", "entry": 100.0,
         "sl": 98.0, "tp1": 103.0, "tp2": 106.0, "tp3": 109.0, "result": "", "result_rr": 0.0,
         "created_at": created, "order_id": "", "state": "PENDING", "strategy": "LEVELS", "exchange": "bybit",
         "tp_placed": 0, "qty": 0.0}
    r.update(o)
    return r


def bars_series(start_ms, n, p0, step, wiggle=0.002, tf_ms=3_600_000, seed=1):
    out = []
    p = p0
    x = seed
    for i in range(n):
        x = (x * 1103515245 + 12345) % (2 ** 31)
        r = (x / 2 ** 31 - 0.5) * wiggle
        o = p
        c = p * (1 + step + r)
        h = max(o, c) * (1 + abs(r) / 2)
        lo = min(o, c) * (1 - abs(r) / 2)
        out.append([start_ms + i * tf_ms, round(o, 6), round(h, 6), round(lo, 6), round(c, 6), 1000.0 + i])
        p = c
    return out


BTC_DOWN = bars_series(int((T0 - 130 * 3600) * 1000), 120, 50000.0, -0.003, seed=7)
SOL_1H = bars_series(int((T0 - 110 * 3600) * 1000), 100, 90.0, 0.001, seed=3)
AVAX_1H = [[b[0], b[1] / 5, b[2] / 5, b[3] / 5, b[4] / 5, b[5]] for b in bars_series(int((T0 - 110 * 3600) * 1000), 100, 90.0, 0.001, seed=3)]
DOGE_1H = bars_series(int((T0 - 110 * 3600) * 1000), 100, 0.2, -0.0005, wiggle=0.03, seed=99)

CASES: list = []


def case(name, user=None, kw=None, calls=None, trades=None, script=None, **extra):
    u = None if user is False else {**BASE_USER, **(user or {})}
    k = {**BASE_KW, **(kw or {})}
    c = {
        "name": name, "clock": extra.pop("clock", T0), "user": u,
        "calls": calls if calls is not None else [k],
        "trades": trades if trades is not None else [trade_row(k["trade_id"], extra.get("clock", T0) - 5,
                                                               symbol=k["symbol"], direction=k["direction"],
                                                               strategy=k["strategy"], exchange=k["exchange"])],
        "script": script or {},
    }
    c.update(extra)
    CASES.append(c)
    return c


def kws(**o):
    return {**BASE_KW, **o}


OK_OPEN = {"ok": True, "order_id": "OID-1", "qty": "1.5", "pos_idx": 0, "tp_placed": True}

# 1. happy paths per exchange
case("ok_bybit_limit")
case("ok_bybit_demo_en", user={"lang": "en"}, kw={"bybit_demo": True})
case("ok_bingx", kw={"exchange": "bingx", "symbol": "DOGE-USDT"},
     script={"bingx.get_positions": [{"ret": [{"symbol": "DOGE-USDT", "side": "LONG", "size": 10.0}]}]})
case("ok_binance", kw={"exchange": "binance"},
     script={"binance.get_positions": [{"ret": [{"symbol": "SOLUSDT", "side": "LONG", "size": 1.5}]}]})
case("ok_okx", user={"okx_passphrase": "PP"}, kw={"exchange": "okx"},
     script={"okx.get_positions": [{"ret": [{"pos": 2.0, "posSide": "long", "slTriggerPx": 98.0}]}]})
case("okx_no_passphrase", kw={"exchange": "okx"})
case("unknown_exchange_as_bybit", kw={"exchange": "kraken"})
case("admin_free_bypass", user={"user_id": 123, "sub_plan": "free"},
     kw={"user_id": 123}, trades=[trade_row("T1", T0 - 5, user_id=123)])
case("confirm_mode", kw={"auto_trade_mode": "confirm"})
case("prefer_market", user={"prefer_market_entry": 1})
case("market_order_volume", kw={"order_type": "Market", "strategy": "VOLUME"})

# 2. pre-lock gates
case("ks_halted_new", ks=["HALTED_NEW", "maintenance"])
case("ks_halted_all_no_reason", ks=["HALTED_ALL", ""])
case("plan_free", user={"sub_plan": "free"})
case("plan_no_row", user=False)
case("plan_trial_legacy", user={"sub_plan": "trial"})
case("symbol_unavailable", symbol_ok=False)
case("symbol_check_raises", symbol_ok="raise")
case("auto_trade_off", user={"auto_trade": 0})
case("zb_cooldown_active", state={"zb": [[U, "bybit", T0 + 600.0]]})
case("commodity_block_active", state={"commodity": [[U, "SOL-USDT-SWAP", T0 + 3600.0]]})
case("risk_cap", user={"max_risk_pct": 2.0}, kw={"risk_pct": 3.0})
case("trend_ctx_strong_counter", kw={"trend_ctx": "strong_counter"})
case("trend_ctx_counter", kw={"trend_ctx": "counter"})
case("trend_ctx_strong_counter_filters_off", user={"filters_all_off": 1}, kw={"trend_ctx": "strong_counter"})
case("fixed_amount_ok", user={"fixed_amount": 50.0}, script={"bybit.get_balance": [{"ret": 500.0}]})
case("fixed_amount_zero_balance", user={"fixed_amount": 50.0}, script={"bybit.get_balance": [{"ret": 0.0}]})
case("fixed_amount_timeout", user={"fixed_amount": 50.0}, script={"bybit.get_balance": [{"hang": True}]})
case("fixed_amount_error_okx", user={"fixed_amount": 50.0, "okx_passphrase": "PP"}, kw={"exchange": "okx"},
     script={"okx.get_balance": [{"raise": "50113 Invalid Sign"}]})
case("disabled_day", user={"autotrade_disabled_days": "2,5"})
case("disabled_day_twice", user={"autotrade_disabled_days": " 2 , x"},
     calls=[kws(trade_id="T1"), kws(trade_id="T2")],
     trades=[trade_row("T1", T0 - 5), trade_row("T2", T0 - 4)])
case("smc_hour_enforce", clock=H18, kw={"strategy": "SMC", "entry_low": 99.0, "entry_high": 101.0, "entry": 99.0})
case("smc_hour_shadow", clock=H18, config={"SMC_HOUR_FILTER_MODE": "shadow"}, regime="ranging",
     kw={"strategy": "SMC", "entry_low": 99.0, "entry_high": 101.0, "entry": 99.0})
case("smc_hour_user_optout", clock=H18, user={"hour_filter_enabled": 0},
     kw={"strategy": "SMC", "entry_low": 99.0, "entry_high": 101.0, "entry": 99.0})
case("smc_hour_custom_list", clock=T0, config={"BAD_HOURS_UTC": {"SMC": [10, 11]}},
     kw={"strategy": "SMC", "entry_low": 99.0, "entry_high": 101.0, "entry": 99.0})
case("levels_hour_enforce", env={"LEVELS_HOUR_FILTER_ENABLED": "1", "LEVELS_HOUR_FILTER_MODE": "ENFORCE"})
case("levels_hour_shadow", env={"LEVELS_HOUR_FILTER_ENABLED": "1"})
case("levels_hour_bad_list", env={"LEVELS_HOUR_FILTER_ENABLED": "1", "LEVELS_HOUR_FILTER_MODE": "enforce",
                                  "LEVELS_BAD_HOURS_UTC": "9,x,10"})
case("min_quality_block", user={"min_signal_quality": 5}, kw={"quality": 4})
case("trending_only_ranging", user={"trade_trending_only": 1}, regime="ranging")
case("trending_only_trending", user={"trade_trending_only": 1}, regime="trending_up")
case("counter_trend_blocked", regime="trending_down")
case("counter_trend_allowed", user={"allow_counter_trend": 1}, regime="trending_down")
case("regime_from_btc_candles", regime=None, candles={"BTC-USDT-SWAP|1H": BTC_DOWN})
case("btc_corr_block_long", user={"allow_counter_trend": 1, "btc_correlation_block": 1}, regime="trending_down")
case("btc_corr_block_short", user={"allow_counter_trend": 1, "btc_correlation_block": 1}, regime="trending_up",
     kw={"direction": "SHORT", "sl": 102.0, "tp1": 97.0, "tp2": 94.0, "tp3": 91.0},
     trades=[trade_row("T1", T0 - 5, direction="SHORT")])
case("funding_against", script={"bybit.get_funding_rate": [{"ret": 0.0021}]})
case("funding_timeout", script={"bybit.get_funding_rate": [{"hang": True}]})
case("funding_error", script={"bybit.get_funding_rate": [{"raise": "tickers down"}]})
case("spread_block", script={"bybit.get_spread_pct": [{"ret": 0.5}]})
case("spread_disabled", user={"spread_check_enabled": 0}, script={"bybit.get_spread_pct": [{"ret": 0.5}]})
case("sl_streak", trades=[trade_row("T1", T0 - 5)] + [
    trade_row(f"S{i}", T0 - 3600 * (i + 1), result="SL", result_rr=-1.0, order_id=f"o{i}", symbol="XRP-USDT-SWAP")
    for i in range(3)])
case("circuit_breaker_user", user={"circuit_breaker_enabled": 1, "circuit_breaker_threshold_r": 2.0},
     trades=[trade_row("T1", T0 - 5), trade_row("L1", T0 - 7200, result="SL", result_rr=-1.5, order_id="a"),
             trade_row("L2", T0 - 3600, result="MANUAL", result_rr=-1.0, order_id="b")])
case("circuit_breaker_env", config={"DAILY_MAX_LOSS_R": 1.0},
     trades=[trade_row("T1", T0 - 5), trade_row("L1", T0 - 7200, result="SL", result_rr=-1.25, order_id="a")])
case("prop_balance_error", user={"prop_mode": 1, "prop_start_balance": 10000.0},
     script={"bybit.get_balance": [{"raise": "connection reset by peer while reading the wallet balance"}]})
case("prop_balance_timeout", user={"prop_mode": 1, "prop_start_balance": 10000.0},
     script={"bybit.get_balance": [{"hang": True}]})
case("prop_balance_zero", user={"prop_mode": 1, "prop_start_balance": 10000.0},
     script={"bybit.get_balance": [{"ret": 0.0}]})
case("prop_dd_block", user={"prop_mode": 1, "prop_start_balance": 10000.0, "prop_max_dd": 5.0},
     script={"bybit.get_balance": [{"ret": 9450.0}]})
case("prop_ok_bookkeeping", user={"prop_mode": 1, "prop_start_balance": 10000.0, "prop_base_risk": 1.5,
                                  "prop_day_start_balance": 10000.0, "prop_trading_days": 2, "prop_peak_balance": 10050.0},
     script={"bybit.get_balance": [{"ret": 10100.0}]})
case("challenge_block", challenge="daily_trades")
case("challenge_error", challenge={"raise": "kv corrupt"})
case("zero_risk", kw={"sl": 99.995})

# 3. inside the per-user lock
case("duplicate_symbol", trades=[trade_row("T1", T0 - 5), trade_row("T0", T0 - 900, order_id="X1")])
case("limit_reached_en", user={"lang": "en"}, kw={"max_trades": 1},
     trades=[trade_row("T1", T0 - 5), trade_row("T0", T0 - 900, symbol="ETH-USDT-SWAP", order_id="X1")])
case("cross_direction", trades=[trade_row("T1", T0 - 5), trade_row("T0", T0 - 900, direction="SHORT")])
case("max_sl_wide", kw={"sl": 90.0})
case("leverage_cap", kw={"sl": 96.0, "leverage": 25})
case("max_sl_user_value", user={"smc_max_sl_pct": 1.5}, kw={"sl": 98.0, "leverage": "x"})
case("max_sl_filters_off", user={"filters_all_off": 1}, kw={"sl": 90.0})

# 4. placement path
case("stale_price", script={"bybit.get_last_price": [{"ret": 110.0}]})
case("stale_threshold_from_atr", candles={"SOL-USDT-SWAP|1H": SOL_1H}, script={"bybit.get_last_price": [{"ret": 102.5}]})
case("stale_check_timeout", script={"bybit.get_last_price": [{"hang": True}, {"ret": 100.0}]})
case("c3_sl_breached", script={"bybit.get_last_price": [{"ret": 100.0}, {"ret": 97.5}]})
case("c79_proximity", script={"bybit.get_last_price": [{"ret": 100.0}, {"ret": 98.1}]})
case("pmult_1000x_bybit", kw={"symbol": "PEPE-USDT-SWAP", "entry": 0.00001, "sl": 0.0000098, "tp1": 0.0000103,
                              "tp2": 0.0000106, "tp3": 0.0000109},
     trades=[trade_row("T1", T0 - 5, symbol="PEPE-USDT-SWAP")],
     script={"bybit.get_last_price": [{"ret": 0.01}]})
case("smc_split_bybit", kw={"strategy": "SMC", "entry_low": 99.0, "entry_high": 101.0, "entry": 99.0})
case("smc_split_bybit_reject", kw={"strategy": "SMC", "entry_low": 99.0, "entry_high": 101.0, "entry": 99.0},
     script={"bybit.place_trade_split": [{"ret": {"ok": False, "error": "split margin: insufficient", "insufficient_margin": True}}]})
case("smc_split_bingx_midpoint", kw={"strategy": "SMC", "exchange": "bingx", "entry_low": 99.0, "entry_high": 101.0,
                                     "entry": 99.0},
     script={"bingx.get_positions": [{"ret": [{"symbol": "SOL-USDT", "side": "LONG", "size": 1.5}]}]})
case("ai_filter_layers", user={"ai_filter_settings": '{"market_regime": true, "news_monitor": true, "genome_engine": true}'},
     regime="trending_up", mutation_info={"hours_since_mutation": 2.5, "improvement_pct": 1.25, "generation": 7})
case("ai_filter_blocking", user={"allow_counter_trend": 1, "ai_filter_settings": '{"market_regime": true}'},
     regime="trending_down")
case("ai_filter_bad_json", user={"ai_filter_settings": "{not json"})

# 5. exchange answers
case("reject_generic", script={"bybit.place_trade": [{"ret": {"ok": False, "error": "Ошибка биржи: <b>code 1</b>"}}]})
case("reject_low_notional", script={"bybit.place_trade": [{"ret": {
    "ok": False, "error": "Слишком маленький баланс", "low_notional_skip": True, "requested_risk_pct": 0.5,
    "required_balance": 2000.0}}]})
case("reject_low_notional_defaults", script={"bybit.place_trade": [{"ret": {
    "ok": False, "error": "notional", "low_notional_skip": True}}]})
case("reject_low_notional_throttled", state={"low_notional": [[U, T0 - 100.0]]},
     script={"bybit.place_trade": [{"ret": {"ok": False, "error": "x", "low_notional_skip": True,
                                            "requested_risk_pct": 0.5, "required_balance": 2000.0}}]})
case("reject_zero_balance", script={"bybit.place_trade": [{"ret": {"ok": False, "error": "Недостаточно средств: $0.00 USDT"}}]})
case("reject_110125", script={"bybit.place_trade": [{"ret": {"ok": False, "error": "ErrCode: 110125 commodity terms"}}]})
case("reject_insufficient_margin", script={"bybit.place_trade": [{"ret": {"ok": False, "error": "margin pre-check",
                                                                       "insufficient_margin": True}}]})
case("timeout_retry_ok", script={"bybit.place_trade": [{"hang": True}, {"ret": OK_OPEN}],
                                 "bybit.get_positions": [{"ret": []}, {"ret": [{"size": 1.5, "side": "Buy", "stopLoss": 98.0}]}]})
case("timeout_first_found_position", script={
    "bybit.place_trade": [{"hang": True}],
    "bybit.get_positions": [{"ret": [{"size": 1.5, "side": "Buy", "stopLoss": 0}]}]})
case("timeout_first_found_order", script={
    "bybit.place_trade": [{"hang": True}],
    "bybit.get_positions": [{"ret": [{"size": 0, "side": "Buy"}]}],
    "bybit.get_open_orders": [{"ret": [{"symbol": "SOLUSDT", "orderId": "77"}]}],
    "bybit.cancel_all_orders": [{"ret": {"ok": True, "cancelled": 1}}]})
case("timeout_both_bingx", kw={"exchange": "bingx"}, script={
    "bingx.place_trade": [{"hang": True}],
    "bingx.get_positions": [{"raise": "positions endpoint down"}],
    "bingx.get_open_orders": [{"ret": []}],
    "bingx.cancel_all_orders": [{"ret": {"cancelled": "2"}}]})
case("auth_error_breaker", state={"auth_log": [[U, "bybit", [T0 - 120.0, T0 - 60.0]]]},
     script={"bybit.place_trade": [{"raise": "ErrCode: 10003 API key is invalid"}]})
case("auth_error_first", script={"bybit.place_trade": [{"raise": "ErrCode: 10003 API key is invalid"}]})
case("server_error", script={"bybit.place_trade": [{"raise": "boom <x> & co", "type": "RuntimeError"}]})
case("server_error_dedup", kv={"adm_alert_at_err_501_bybit_RuntimeError": str(T0 - 60.0)},
     script={"bybit.place_trade": [{"raise": "boom again", "type": "RuntimeError"}]})

# 6. background tasks
case("ptp_fallback_ok", user={"partial_tp_enabled": 1}, ptp=[{"ret": False}])
case("ptp_fallback_fail_notify", user={"partial_tp_enabled": 1}, ptp=[{"ret": False}],
     script={"bybit.place_tp_orders": [{"ret": False}]})
case("ptp_fallback_exc_send_fail", user={"partial_tp_enabled": 1}, ptp=[{"ret": False}],
     script={"bybit.place_tp_orders": [{"raise": "tp endpoint 500"}]}, send_fail=["TP"])
case("ptp_fb_skip_unfilled", user={"partial_tp_enabled": 1}, ptp=[{"ret": False}],
     script={"bybit.get_positions": [{"ret": []}], "bybit.cancel_all_orders": [{"ret": {"cancelled": 1}}]})
case("ptp_exception_bingx", user={"partial_tp_enabled": 1}, kw={"exchange": "bingx"}, ptp=[{"raise": "ladder broke"}],
     script={"bingx.get_positions": [{"ret": [{"symbol": "SOL-USDT", "side": "LONG", "size": 1.5}]}],
             "bingx.place_sl_tp_for_position": [{"ret": {"tp_placed": False}}]})
case("ptp_okx_fallback", user={"partial_tp_enabled": 1, "okx_passphrase": "PP"}, kw={"exchange": "okx"},
     ptp=[{"ret": False}], script={"okx.get_positions": [{"ret": [{"pos": 2.0, "posSide": "long"}]}]})
case("limit_unfilled_smc_grace", kw={"strategy": "SMC", "entry_low": 99.0, "entry_high": 101.0, "entry": 99.0},
     script={"bybit.get_positions": [{"ret": []}]})
case("flags_boost_leverage", script={"bybit.place_trade": [{"ret": {
    "ok": True, "order_id": "OID-B", "qty": "3.0", "pos_idx": 1, "tp_placed": False, "risk_boosted": True,
    "risk_actual_pct": 1.8, "risk_requested_pct": 1.0, "leverage_downgraded": True,
    "leverage_requested": 25, "leverage_applied": 10}}]})
case("risk_preview_warm_cache", state={"balance_cache": [[U, "bybit", 2000.0, T0 + 30.0]]})
case("risk_preview_off", user={"show_risk_preview": 0}, state={"balance_cache": [[U, "bybit", 2000.0, T0 + 30.0]]})
case("tilt_revenge", trades=[trade_row("T1", T0 - 5), trade_row("T0", T0 - 100, result="SL", result_rr=-1.0,
                                                                order_id="o", symbol="ETH-USDT-SWAP")])
case("parallel_same_symbol", parallel=True, calls=[kws(trade_id="T1"), kws(trade_id="T2")],
     trades=[trade_row("T1", T0 - 5), trade_row("T2", T0 - 4)])
case("skip_unfilled_escalation", state={"unfilled": [[U, [T0 - 600.0, T0 - 500.0, T0 - 400.0, T0 - 300.0]]]},
     script={"bybit.get_positions": [{"ret": []}]})
case("adaptive_sizing", user={"adaptive_sizing_enabled": 1, "adaptive_sizing_mode": "all"},
     candles={"SOL-USDT-SWAP|1H": SOL_1H},
     trades=[trade_row("T1", T0 - 5)] + [
         trade_row(f"H{i}", T0 - 86400 * (i + 1) / 3, result=("TP1" if i % 3 else "SL"),
                   result_rr=(1.5 if i % 3 else -1.0), order_id=f"h{i}", symbol="ETH-USDT-SWAP")
         for i in range(12)])
case("correlation_block", user={"correlation_cap_enabled": 1, "correlation_cap_threshold": 0.7},
     candles={"SOL-USDT-SWAP|1H": SOL_1H, "AVAX-USDT-SWAP|1H": AVAX_1H},
     trades=[trade_row("T1", T0 - 5), trade_row("T0", T0 - 900, symbol="AVAX-USDT-SWAP", order_id="X1")])
case("correlation_pass", user={"correlation_cap_enabled": 1},
     candles={"SOL-USDT-SWAP|1H": SOL_1H, "DOGE-USDT-SWAP|1H": DOGE_1H},
     trades=[trade_row("T1", T0 - 5), trade_row("T0", T0 - 900, symbol="DOGE-USDT-SWAP", order_id="X1")])
case("no_bot", kw={"bot": False}, user={"partial_tp_enabled": 1}, ptp=[{"ret": False}],
     script={"bybit.place_tp_orders": [{"ret": False}]})


# 7. batch D — [VOL15-RISK-CAP] [SAME-DIR-CAP] [MARKET-ENTRY-NO-SHIFT] [FEE-AWARE-SIZE] (bot c56653d)
VOL15 = {"strategy": "VOLUME", "timeframe": "15m", "order_type": "Market", "sl": 99.4, "tp1": 100.6,
         "tp2": 101.2, "tp3": 101.8}
LN_ANSWER = {"ok": False, "error": "Объём $8.68 < минимума биржи $10", "low_notional_skip": True,
             "requested_risk_pct": 0.21, "required_balance": 4800.77}


def vol15(**o):
    return {**VOL15, **o}


def open_row(tid, sym, direction="LONG", created=T0 - 900, **o):
    return trade_row(tid, created, symbol=sym, direction=direction, order_id=f"X{tid}", **o)


TWO_LONG = [open_row("O1", "ETH-USDT-SWAP"), open_row("O2", "XRP-USDT-SWAP")]

# [VOL15-RISK-CAP] which trades are capped, per exchange
case("d2_vol15_bybit_cap", kw=vol15())
case("d2_vol15_bingx_cap", kw=vol15(exchange="bingx"),
     script={"bingx.get_positions": [{"ret": [{"symbol": "SOL-USDT", "side": "LONG", "size": 10.0}]}]})
case("d2_vol15_binance_cap", kw=vol15(exchange="binance"),
     script={"binance.get_positions": [{"ret": [{"symbol": "SOLUSDT", "side": "LONG", "size": 1.5}]}]})
case("d2_vol15_okx_cap", user={"okx_passphrase": "PP"}, kw=vol15(exchange="okx"),
     script={"okx.get_positions": [{"ret": [{"pos": 2.0, "posSide": "long", "slTriggerPx": 99.4}]}]})
case("d2_vol15_short", kw=vol15(direction="SHORT", sl=100.6, tp1=99.4, tp2=98.8, tp3=98.2),
     trades=[trade_row("T1", T0 - 5, direction="SHORT", strategy="VOLUME")])
case("d2_vol15_tf_spaces_upper", kw=vol15(timeframe=" 15M "))
case("d2_vol_1h_no_cap", kw=vol15(timeframe="1h"))
case("d2_vol_4h_no_cap", kw=vol15(timeframe="4h"))
case("d2_vol_tf_empty_no_cap", kw=vol15(timeframe=""))
case("d2_vol_strategy_lower", kw=vol15(strategy="volume"))
case("d2_levels_15m_no_cap", kw={"timeframe": "15m"})
case("d2_smc_15m_split_no_cap", kw={"strategy": "SMC", "timeframe": "15m", "entry_low": 99.0, "entry_high": 101.0,
                                    "entry": 99.0})
case("d2_vol15_risk_below_cap", kw=vol15(risk_pct=0.2))
case("d2_vol15_notional_mode", user={"risk_mode": "notional"}, kw=vol15())
case("d2_vol15_margin_mode", user={"risk_mode": "margin"}, kw=vol15())
case("d2_vol15_ctx_counter_after_cap", kw=vol15(trend_ctx="counter"))
case("d2_vol15_ctx_x2_reclamped", ctx_risk={"aligned": 2.0}, kw=vol15(trend_ctx="aligned", risk_pct=0.2))
case("d2_vol15_fixed_amount_reclamped", user={"fixed_amount": 50.0}, kw=vol15(),
     script={"bybit.get_balance": [{"ret": 500.0}]})
case("d2_vol15_prop_reclamped", user={"prop_mode": 1, "prop_start_balance": 10000.0, "prop_base_risk": 1.5,
                                      "prop_day_start_balance": 10000.0, "prop_peak_balance": 10050.0},
     kw=vol15(risk_pct=0.2), script={"bybit.get_balance": [{"ret": 10100.0}]})
case("d2_vol15_max_risk_lower_wins", user={"max_risk_pct": 0.2}, kw=vol15())
case("d2_vol15_max_risk_then_cap", user={"max_risk_pct": 0.5}, kw=vol15())
# env VOLUME_15M_MAX_RISK_PCT
for _tag, _raw in (("05", "0.5"), ("spaces", " 0.1 "), ("blank", ""), ("sci", "1e-1"), ("underscore", "0_1"),
                   ("zero", "0"), ("neg", "-1"), ("abc", "abc"), ("nan", "nan"), ("inf", "inf"), ("hex", "0x10"),
                   ("big", "5")):
    case(f"d2_vol15_env_{_tag}", env={"VOLUME_15M_MAX_RISK_PCT": _raw}, kw=vol15())
case("d2_vol15_env_abc_warn_once", env={"VOLUME_15M_MAX_RISK_PCT": "abc"},
     calls=[kws(**vol15(trade_id="T1")), kws(**vol15(trade_id="T2", symbol="ETH-USDT-SWAP"))],
     trades=[trade_row("T1", T0 - 5, strategy="VOLUME"), trade_row("T2", T0 - 4, strategy="VOLUME", symbol="ETH-USDT-SWAP")])
# the trade-opened message / risk_capped_warning numbers ([FEE-AWARE-SIZE] review fix R2)
case("d2_risk_capped_warning_local_numbers", user={"max_risk_pct": 1.0}, kw={"risk_pct": 2.0, "sl": 99.4, "tp1": 100.6},
     script={"bybit.place_trade": [{"ret": {**OK_OPEN, "risk_requested_pct": 0.83, "risk_applied_pct": 0.83}}]})
case("d2_risk_capped_warning_fractional", user={"max_risk_pct": 0.75}, kw={"risk_pct": 1.5})
case("d2_risk_capped_warning_vol15", user={"max_risk_pct": 0.3}, kw=vol15())

# [VOL15-RISK-CAP] the VOLUME 15m low-notional pause (review fix R1)
# V1 VOLUME 15m low notional → own pause (no shared cooldown); V2 VOLUME 15m skipped without an exchange
# call; V3 VOLUME 1h and L4 LEVELS place (the pause is VOLUME 15m only); L4's open resets the pause
# (reset_zero_balance_cooldown) → V5 VOLUME 15m is placed again
case("d2_vol15_low_notional_pause_flow",
     calls=[kws(**vol15(trade_id="V1")), kws(**vol15(trade_id="V2", symbol="XRP-USDT-SWAP")),
            kws(**vol15(trade_id="V3", symbol="DOGE-USDT-SWAP", timeframe="1h", direction="SHORT", sl=100.6,
                        tp1=99.4, tp2=98.8, tp3=98.2)),
            kws(trade_id="L4", symbol="ETH-USDT-SWAP"), kws(**vol15(trade_id="V5", symbol="LINK-USDT-SWAP"))],
     trades=[trade_row("V1", T0 - 5, strategy="VOLUME"), trade_row("V2", T0 - 4, strategy="VOLUME", symbol="XRP-USDT-SWAP"),
             trade_row("V3", T0 - 3, strategy="VOLUME", symbol="DOGE-USDT-SWAP", direction="SHORT"),
             trade_row("L4", T0 - 2, symbol="ETH-USDT-SWAP"),
             trade_row("V5", T0 - 1, strategy="VOLUME", symbol="LINK-USDT-SWAP")],
     script={"bybit.place_trade": [{"ret": LN_ANSWER}, {"ret": OK_OPEN}]})
case("d2_vol15_low_notional_en", user={"lang": "en"}, kw=vol15(), script={"bybit.place_trade": [{"ret": LN_ANSWER}]})
case("d2_vol15_low_notional_no_trader_numbers", kw=vol15(),
     script={"bybit.place_trade": [{"ret": {"ok": False, "error": "notional", "low_notional_skip": True}}]})
case("d2_vol15_low_notional_throttled", state={"low_notional": [[U, T0 - 100.0]]}, kw=vol15(),
     script={"bybit.place_trade": [{"ret": LN_ANSWER}]})
case("d2_vol15_low_notional_reclamped_own_pause", user={"fixed_amount": 50.0}, kw=vol15(),
     script={"bybit.get_balance": [{"ret": 500.0}], "bybit.place_trade": [{"ret": LN_ANSWER}]})
# the risk is ≤ the cap at the first point and only the clamp before the sizing lowers it (ctx ×2) — that
# clamp alone marks the trade capped → own pause, the vol15 text
case("d2_vol15_low_notional_ctx_reclamp_own_pause", ctx_risk={"aligned": 2.0}, kw=vol15(trend_ctx="aligned", risk_pct=0.2),
     script={"bybit.place_trade": [{"ret": LN_ANSWER}]})
# the cap in the text is f"{cap:g}"
case("d2_vol15_low_notional_cap_g_format", env={"VOLUME_15M_MAX_RISK_PCT": "0.1234567"}, kw=vol15(),
     script={"bybit.place_trade": [{"ret": LN_ANSWER}]})
case("d2_vol15_low_notional_cap_g_exp", env={"VOLUME_15M_MAX_RISK_PCT": "0.00001"}, kw=vol15(),
     script={"bybit.place_trade": [{"ret": LN_ANSWER}]})
case("d2_vol15_low_notional_uncapped_shared_cd", kw=vol15(risk_pct=0.2), script={"bybit.place_trade": [{"ret": LN_ANSWER}]})
case("d2_levels_low_notional_shared_cd", script={"bybit.place_trade": [{"ret": LN_ANSWER}]})
case("d2_vol15_zero_balance_shared_cd", kw=vol15(),
     script={"bybit.place_trade": [{"ret": {**LN_ANSWER, "error": "Недостаточно средств: $0.00 USDT"}}]})
case("d2_vol15_insufficient_margin_shared_cd", kw=vol15(),
     script={"bybit.place_trade": [{"ret": {**LN_ANSWER, "insufficient_margin": True}}]})
case("d2_vol15_pause_active_skip", state={"vol15_ln": [[U, "bybit", T0 + 900.0]]}, kw=vol15())
case("d2_vol15_pause_other_exchange", state={"vol15_ln": [[U, "bybit", T0 + 900.0]]}, kw=vol15(exchange="bingx"),
     script={"bingx.get_positions": [{"ret": [{"symbol": "SOL-USDT", "side": "LONG", "size": 10.0}]}]})
case("d2_vol15_pause_active_uncapped", state={"vol15_ln": [[U, "bybit", T0 + 900.0]]}, kw=vol15(risk_pct=0.2))
case("d2_vol15_pause_expired", state={"vol15_ln": [[U, "bybit", T0 - 1.0]]}, kw=vol15())
case("d2_vol15_pause_cap_off", env={"VOLUME_15M_MAX_RISK_PCT": "0"}, state={"vol15_ln": [[U, "bybit", T0 + 900.0]]},
     kw=vol15())
case("d2_vol15_pause_not_for_1h", state={"vol15_ln": [[U, "bybit", T0 + 900.0]]}, kw=vol15(timeframe="1h"))
case("d2_vol15_pause_not_for_levels", state={"vol15_ln": [[U, "bybit", T0 + 900.0]]})
case("d2_vol15_pause_zb_first", state={"vol15_ln": [[U, "bybit", T0 + 900.0]], "zb": [[U, "bybit", T0 + 600.0]]},
     kw=vol15())
case("d2_vol15_pause_reset_by_open", state={"vol15_ln": [[U, "bybit", T0 + 900.0]]},
     calls=[kws(trade_id="L1", symbol="ETH-USDT-SWAP"), kws(**vol15(trade_id="V2"))],
     trades=[trade_row("L1", T0 - 5, symbol="ETH-USDT-SWAP"), trade_row("V2", T0 - 4, strategy="VOLUME")])

# [SAME-DIR-CAP]
case("d2_samedir_third_long", trades=[trade_row("T1", T0 - 5)] + TWO_LONG)
case("d2_samedir_third_long_en", user={"lang": "en"}, kw={"symbol": "BTC-USDT"},
     trades=[trade_row("T1", T0 - 5, symbol="BTC-USDT")] + TWO_LONG)
case("d2_samedir_short_allowed", kw={"direction": "SHORT", "sl": 102.0, "tp1": 97.0, "tp2": 94.0, "tp3": 91.0},
     trades=[trade_row("T1", T0 - 5, direction="SHORT")] + TWO_LONG)
case("d2_samedir_two_short_block", kw={"direction": "SHORT", "sl": 102.0, "tp1": 97.0, "tp2": 94.0, "tp3": 91.0},
     trades=[trade_row("T1", T0 - 5, direction="SHORT"), open_row("O1", "ETH-USDT-SWAP", "short"),
             open_row("O2", "XRP-USDT-SWAP", "Short")])
case("d2_samedir_one_open", trades=[trade_row("T1", T0 - 5), open_row("O1", "ETH-USDT-SWAP")])
case("d2_samedir_not_counted", trades=[trade_row("T1", T0 - 5), open_row("O1", "ETH-USDT-SWAP"),
                                       open_row("C1", "XRP-USDT-SWAP", result="SL", result_rr=-1.0),
                                       open_row("C2", "DOGE-USDT-SWAP", result="SKIP"),
                                       trade_row("N1", T0 - 700, symbol="LINK-USDT-SWAP"),
                                       open_row("U1", "ADA-USDT-SWAP", user_id=777)])
case("d2_samedir_mixed_strategies", trades=[trade_row("T1", T0 - 5), open_row("O1", "ETH-USDT-SWAP", strategy="SMC"),
                                            open_row("O2", "XRP-USDT-SWAP", strategy="VOLUME")])
for _tag, _raw in (("zero", "0"), ("neg", "-3"), ("three", "3"), ("one", "1"), ("abc", "abc"), ("blank", ""),
                   ("float", "2.0"), ("float_trunc", "2.9"), ("inf", "inf"), ("nan", "nan"), ("spaces", " 3 ")):
    case(f"d2_samedir_env_{_tag}", env={"AUTO_TRADE_MAX_SAME_DIRECTION": _raw}, trades=[trade_row("T1", T0 - 5)] + TWO_LONG)
case("d2_samedir_env_one_single_open", env={"AUTO_TRADE_MAX_SAME_DIRECTION": "1"},
     trades=[trade_row("T1", T0 - 5), open_row("O1", "ETH-USDT-SWAP")])
case("d2_samedir_env_abc_warn_once", env={"AUTO_TRADE_MAX_SAME_DIRECTION": "abc"},
     calls=[kws(trade_id="T1"), kws(trade_id="T2", symbol="ETH-USDT-SWAP")],
     trades=[trade_row("T1", T0 - 5), trade_row("T2", T0 - 4, symbol="ETH-USDT-SWAP")])
case("d2_samedir_count_fails", count_fail="database is locked", trades=[trade_row("T1", T0 - 5)])
case("d2_samedir_cap_off_no_count", count_fail="database is locked", env={"AUTO_TRADE_MAX_SAME_DIRECTION": "0"})
case("d2_samedir_filters_off_still_blocks", user={"filters_all_off": 1}, trades=[trade_row("T1", T0 - 5)] + TWO_LONG)
case("d2_samedir_confirm_mode_blocked", kw={"auto_trade_mode": "confirm"}, trades=[trade_row("T1", T0 - 5)] + TWO_LONG)
case("d2_samedir_max_trades_first", kw={"max_trades": 2}, trades=[trade_row("T1", T0 - 5)] + TWO_LONG)
case("d2_samedir_no_trade_id", kw={"trade_id": ""}, trades=TWO_LONG)
case("d2_samedir_symbol_escaped", kw={"symbol": "A<B>-USDT-SWAP"},
     trades=[trade_row("T1", T0 - 5, symbol="A<B>-USDT-SWAP")] + TWO_LONG)

# [MARKET-ENTRY-NO-SHIFT] Market vs Limit entry passed to the trader
case("d2_market_short_bingx", kw={"exchange": "bingx", "order_type": "Market", "direction": "SHORT", "sl": 102.0,
                                  "tp1": 97.0, "tp2": 94.0, "tp3": 91.0},
     trades=[trade_row("T1", T0 - 5, direction="SHORT")],
     script={"bingx.get_positions": [{"ret": [{"symbol": "SOL-USDT", "side": "SHORT", "size": 10.0}]}]})
case("d2_limit_short_bingx", kw={"exchange": "bingx", "direction": "SHORT", "sl": 102.0, "tp1": 97.0, "tp2": 94.0,
                                 "tp3": 91.0},
     trades=[trade_row("T1", T0 - 5, direction="SHORT")],
     script={"bingx.get_positions": [{"ret": [{"symbol": "SOL-USDT", "side": "SHORT", "size": 10.0}]}]})
case("d2_market_binance", kw={"exchange": "binance", "order_type": "Market"},
     script={"binance.get_positions": [{"ret": [{"symbol": "SOLUSDT", "side": "LONG", "size": 1.5}]}]})
case("d2_market_okx", user={"okx_passphrase": "PP"}, kw={"exchange": "okx", "order_type": "market"},
     script={"okx.get_positions": [{"ret": [{"pos": 2.0, "posSide": "long", "slTriggerPx": 98.0}]}]})
case("d2_market_spaces_case", kw={"order_type": " MARKET "})
case("d2_prefer_market_bingx", user={"prefer_market_entry": 1}, kw={"exchange": "bingx"},
     script={"bingx.get_positions": [{"ret": [{"symbol": "SOL-USDT", "side": "LONG", "size": 10.0}]}]})
case("d2_market_ptp_entry", user={"partial_tp_enabled": 1}, kw={"order_type": "Market"})
case("d2_market_c79_proximity", kw={"order_type": "Market"}, script={"bybit.get_last_price": [{"ret": 100.0}, {"ret": 98.19}]})
case("d2_limit_c79_proximity", script={"bybit.get_last_price": [{"ret": 100.0}, {"ret": 98.19}]})

# [FEE-AWARE-SIZE]
for _tag, _raw in (("0", "0"), ("false", "false"), ("off_upper", "OFF"), ("no_spaces", " no "), ("yes", "yes"),
                   ("1", "1"), ("blank", "")):
    case(f"d2_fee_env_{_tag}", env={"AUTO_TRADE_FEE_AWARE_SIZING": _raw})
case("d2_fee_off_vol15", env={"AUTO_TRADE_FEE_AWARE_SIZING": "0"}, kw=vol15())
case("d2_fee_split_unknown_exchange", kw={"strategy": "SMC", "exchange": "kraken", "entry_low": 99.0, "entry_high": 101.0,
                                          "entry": 99.0})
case("d2_fee_split_off", env={"AUTO_TRADE_FEE_AWARE_SIZING": "false"},
     kw={"strategy": "SMC", "entry_low": 99.0, "entry_high": 101.0, "entry": 99.0})
case("d2_fee_split_notional_user", user={"risk_mode": "notional"},
     kw={"strategy": "SMC", "entry_low": 99.0, "entry_high": 101.0, "entry": 99.0})
case("d2_fee_notional_mode", user={"risk_mode": "notional"})
case("d2_fee_margin_mode_upper", user={"risk_mode": " Margin "})
case("d2_fee_risk_mode_upper", user={"risk_mode": "RISK"})
case("d2_fee_taker_bad_binance", taker_fee={"binance": 0.05}, kw={"exchange": "binance"},
     script={"binance.get_positions": [{"ret": [{"symbol": "SOLUSDT", "side": "LONG", "size": 1.5}]}]})
case("d2_fee_taker_missing_bingx", taker_fee={"bingx": "__del__"}, kw={"exchange": "bingx"},
     script={"bingx.get_positions": [{"ret": [{"symbol": "SOL-USDT", "side": "LONG", "size": 10.0}]}]})
case("d2_fee_taker_bool_okx", taker_fee={"okx": True}, user={"okx_passphrase": "PP"}, kw={"exchange": "okx"},
     script={"okx.get_positions": [{"ret": [{"pos": 2.0, "posSide": "long", "slTriggerPx": 98.0}]}]})
case("d2_fee_taker_str_bybit", taker_fee={"bybit": "0.0006"})
case("d2_fee_taker_zero_bybit", taker_fee={"bybit": 0})
case("d2_fee_unknown_exchange", kw={"exchange": "kraken"})
case("d2_fee_sl_zero_filters_off", user={"filters_all_off": 1}, kw={"sl": 0.0})
case("d2_fee_wide_stop_tiny_factor", user={"smc_max_sl_pct": 50.0}, kw={"sl": 60.0, "leverage": 1})
case("d2_fee_tiny_stop", kw={"sl": 99.95})


# ── pure helpers (called directly) and db_count_open_trades ──────────────────
def _helpers():
    out = {"env": [], "risk_cap": [], "taker": [], "factor": [], "required_balance": []}
    saved = {k: os.environ.get(k) for k in ("VOLUME_15M_MAX_RISK_PCT", "AUTO_TRADE_MAX_SAME_DIRECTION",
                                             "AUTO_TRADE_FEE_AWARE_SIZING")}
    raws = [None, "", "  ", "0.25", " 0.1 ", "1e-1", "0_5", "+2", "-0", "0", "-1", "abc", "nan", "NaN", "inf", "-inf",
            "Infinity", "0x10", "1,5", "3", "2.9", "-2.5", "1e400", "١", "5\u00a0"]
    fns = [("VOLUME_15M_MAX_RISK_PCT", auto_trade._vol15_max_risk_pct),
           ("AUTO_TRADE_MAX_SAME_DIRECTION", auto_trade._same_direction_cap),
           ("AUTO_TRADE_FEE_AWARE_SIZING", auto_trade._fee_aware_sizing_enabled)]
    for name, fn in fns:
        for raw in raws + (["false", "FALSE", " off ", "No", "yes", "on", "true"] if "FEE" in name else []):
            auto_trade._ENV_WARNED.clear()
            if raw is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = raw
            RECS.clear()
            CAPTURE[0] = True
            v1 = fn()
            v2 = fn()
            CAPTURE[0] = False
            out["env"].append({"name": name, "raw": raw, "values": [jsonable(v1), jsonable(v2)],
                               "logs": [r[2] for r in RECS if r[1] == "log"]})
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    auto_trade._ENV_WARNED.clear()
    for strat in ("VOLUME", "volume", " VOLUME", "LEVELS", "SMC", "", None):
        for tf in ("15m", " 15M ", "1h", "4h", "", None, "15"):
            for rm in ("risk", " RISK ", "notional", "margin", "", None):
                out["risk_cap"].append([strat, tf, rm, auto_trade._vol15_risk_cap(strat, tf, rm)])
    for ex in ("bybit", "bingx", "binance", "okx", "kraken", "", None, "BINGX", "Okx"):
        out["taker"].append([ex, auto_trade._taker_fee(ex)])
    for e, sl_, ex in ((100.0, 99.4, "bybit"), (100.0, 99.4, "bingx"), (100.0, 99.4, "binance"), (100.0, 99.4, "okx"),
                       (100.0, 100.6, "bybit"), (0.00001, 0.0000098, "bybit"), (65000.0, 64610.0, "binance"),
                       (100.0, 100.0, "bybit"), (0.0, 99.0, "bybit"), (100.0, 0.0, "okx"), (-5.0, 1.0, "bybit"),
                       (100.0, -1.0, "bybit"), (None, 99.0, "bybit"), (100.0, None, "bingx"), ("100", "99", "okx"),
                       ("abc", 99.0, "bybit"), (3.3, 3.1, "kraken"), (100, 98, "binance"), (True, 0.5, "bybit")):
        f, rt = auto_trade._fee_aware_factor(e, sl_, ex)
        out["factor"].append([e, sl_, ex, f, rt])
    for args in ((100.0, 99.4, 0.2083, 4800.77), (100.0, 99.4, 0.2083, 0), (100.0, 99.4, 0.2083, None),
                 (100.0, 99.4, 0.25, 4000.0), (100.0, 99.4, 0.2083, 100.0), (100.0, 98.0, 0.9434, 1060.0),
                 (0.00001, 0.0000098, 0.2083, 4800.77), (65000.0, 64610.0, 0.2206, 4533.09),
                 (0, 99.4, 0.2083, 4800.77), (100.0, 0, 0.2083, 4800.77), (100.0, 99.4, 0, 4800.77),
                 (100.0, 100.0, 0.2083, 4800.77), (None, None, None, None), (100.0, 99.4, -0.1, 12.5),
                 ("100", "99.4", "0.2083", "4800.77"), ("abc", 99.4, 0.2083, 77.9), ("abc", 99.4, 0.2083, "x"),
                 (100.0, 101.0, 0.25, 0.0), (100.0, 99.0, 0.25, 3999.99), (100.0, 99.4, 0.2083, float("nan")),
                 (100.0, 99.0, 1e-9, 1e12), (50.0, 49.5, 0.125, 8000.0), (0.5, 0.497, 0.2083, 48.0)):
        try:
            v = ["ok", auto_trade._vol15_required_balance(*args)]
        except Exception as e:  # noqa: BLE001
            v = ["raise", type(e).__name__]
        out["required_balance"].append([jsonable(list(args)), v])
    return out


async def _count_vectors():
    rows = [
        trade_row("A1", T0 - 900, order_id="x1"),
        trade_row("A2", T0 - 800, symbol="ETH-USDT-SWAP", order_id="x2"),
        trade_row("A3", T0 - 700, symbol="XRP-USDT-SWAP", direction="SHORT", order_id="x3"),
        trade_row("A4", T0 - 600, symbol="DOGE-USDT-SWAP", direction="long", order_id="x4"),
        trade_row("A5", T0 - 500, symbol="LINK-USDT-SWAP", direction="Short", order_id="x5"),
        trade_row("A6", T0 - 400, symbol="ADA-USDT-SWAP", order_id=""),
        trade_row("A7", T0 - 300, symbol="BNB-USDT-SWAP", order_id="x7", result="SL", result_rr=-1.0),
        trade_row("A8", T0 - 200, symbol="TRX-USDT-SWAP", order_id="x8", result="SKIP"),
        trade_row("A9", T0 - 100, symbol="SUI-USDT-SWAP", order_id="x9", user_id=777),
        trade_row("A10", T0 - 50, symbol="APT-USDT-SWAP", order_id="x10", direction=""),
        trade_row("A11", T0 - 40, symbol="NEAR-USDT-SWAP", order_id="x11", direction=" LONG"),
    ]
    con = db_conn()
    for t in ("users", "trades", "kv", "trade_events"):
        con.execute(f"DELETE FROM {t}")
    for tr in rows:
        cols = list(tr.keys())
        con.execute(f"INSERT INTO trades ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                    [tr[k] for k in cols])
    con.commit()
    con.close()
    queries = []
    for uid in (U, 777, 999):
        for exc in ("", "A1", "A3", "A4", "NOPE"):
            for d in ("", "LONG", "SHORT", "long", " short ", "BOTH"):
                queries.append([uid, exc, d, await _REAL_COUNT_OPEN(uid, exclude_trade_id=exc, direction=d)])
    queries.append([U, "A2", None, await _REAL_COUNT_OPEN(U, "A2")])
    return {"rows": rows, "queries": queries}


# ── runner ──────────────────────────────────────────────────────────────────
USER_COLS: list = []


def db_conn():
    c = sqlite3.connect(DBP, timeout=30)
    c.row_factory = sqlite3.Row
    return c


CFG_KEYS = ("SMC_HOUR_FILTER_ENABLED", "SMC_HOUR_FILTER_MODE", "BAD_HOURS_UTC", "DAILY_MAX_LOSS_R")
CFG_ORIG = {k: copy.deepcopy(getattr(Config, k)) for k in CFG_KEYS}


def reset_module_state():
    for d in (auto_trade._trade_locks, auto_trade._idempotency_registry, auto_trade._zero_balance_until,
              auto_trade._commodity_blocklist, auto_trade._auth_fail_log, auto_trade._auth_fail_notified,
              auto_trade._disabled_days_notified, auto_trade._LOW_NOTIONAL_NOTIFY_TS, auto_trade._SKIP_NOTIFY_DEDUP,
              skip_notify._user_unfilled, skip_notify._last_notified, tilt_detector._NOTIFY_DEDUP,
              correlation_cap._CORR_CACHE, balance_cache._BALANCE_CACHE):
        d.clear()
    if hasattr(auto_trade.execute_auto_trade, "_cb_warned"):
        delattr(auto_trade.execute_auto_trade, "_cb_warned")
    auto_trade._ENV_WARNED.clear()                 # [VOL15-RISK-CAP / SAME-DIR-CAP] warn-once registry
    auto_trade._vol15_low_notional_until.clear()   # [VOL15-RISK-CAP] the VOLUME 15m low-notional pause
    ks._cache = None
    market_regime._cached_regime = None
    market_regime._cached_at = 0.0
    UUIDS.n = 0
    PARENT.clear()


def build_user_row(over):
    """The users row the bot itself writes for this user: UserSettings defaults (um.save →
    to_db) with the case's overrides (raw values win), restricted to the users table."""
    from user_manager import UserSettings
    u = UserSettings(user_id=over["user_id"])
    for k, v in over.items():
        if hasattr(u, k):
            setattr(u, k, v)
    d = u.to_db()
    d.update(over)
    return {k: jsonable(v) for k, v in d.items() if k in USER_COLS}


def seed(c):
    con = db_conn()
    for t in ("users", "trades", "kv", "trade_events"):
        con.execute(f"DELETE FROM {t}")
    state, reason = c.get("ks") or ["ACTIVE", ""]
    con.execute("UPDATE operational_state SET state=?, reason=? WHERE id=1", (state, reason))
    if c["user"] is not None:
        row = build_user_row(c["user"])
        c["user_row"] = row
        cols = list(row.keys())
        con.execute(f"INSERT INTO users ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                    [row[k] for k in cols])
    for tr in c["trades"]:
        cols = list(tr.keys())
        con.execute(f"INSERT INTO trades ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                    [tr[k] for k in cols])
    for k, v in (c.get("kv") or {}).items():
        con.execute("INSERT INTO kv (key, value) VALUES (?, ?)", (k, v))
    con.commit()
    con.close()
    st = c.get("state") or {}
    for uid, ex, until in st.get("zb", []):
        auto_trade._zero_balance_until[(uid, ex)] = until
    for uid, sym, until in st.get("commodity", []):
        auto_trade._commodity_blocklist[(uid, sym)] = until
    for uid, ex, tss in st.get("auth_log", []):
        auto_trade._auth_fail_log[(uid, ex)] = list(tss)
    for uid, ts in st.get("low_notional", []):
        auto_trade._LOW_NOTIONAL_NOTIFY_TS[uid] = ts
    for uid, ex, until in st.get("vol15_ln", []):
        auto_trade._vol15_low_notional_until[(uid, ex)] = until
    for uid, ex, bal, exp in st.get("balance_cache", []):
        balance_cache._BALANCE_CACHE[(uid, ex)] = (bal, exp)
    for uid, tss in st.get("unfilled", []):
        skip_notify._user_unfilled[uid].extend(tss)
    if "regime" in c and c["regime"] is not None:
        market_regime._cached_regime = c["regime"]
        market_regime._cached_at = c["clock"] - 60.0
    elif "regime" not in c:
        market_regime._cached_regime = "ranging"
        market_regime._cached_at = c["clock"] - 60.0


def dump_db():
    con = db_conn()
    trades = [dict(r) for r in con.execute(
        "SELECT trade_id, result, result_rr, state, state_changed_at, placement_attempts, order_id, pos_idx, "
        "qty, tp_placed, skip_reason, ai_filter_json FROM trades ORDER BY trade_id")]
    users = [dict(r) for r in con.execute(
        "SELECT user_id, auto_trade, prop_peak_balance, prop_last_trade_day, prop_trading_days, "
        "prop_day_start_balance FROM users ORDER BY user_id")]
    kv = {r["key"]: r["value"] for r in con.execute("SELECT key, value FROM kv ORDER BY key")}
    events = [[r["trade_id"], r["event_type"], r["payload_json"]]
              for r in con.execute("SELECT trade_id, event_type, payload_json FROM trade_events ORDER BY id")]
    con.close()
    return {"trades": trades, "users": users, "kv": kv, "events": events}


def result_json(r):
    if not isinstance(r, dict):
        return jsonable(r)
    out = {}
    for k, v in r.items():
        out[k] = jsonable(v)
    return out


async def run_case(c):
    reset_module_state()
    CASE.clear()
    CASE.update(c)
    SCRIPT.clear()
    for k, v in (c.get("script") or {}).items():
        SCRIPT[k] = copy.deepcopy(v)
    if c.get("ptp"):
        SCRIPT["ptp"] = copy.deepcopy(c["ptp"])
    for k in CFG_KEYS:
        setattr(Config, k, copy.deepcopy(CFG_ORIG[k]))
    for k, v in (c.get("config") or {}).items():
        setattr(Config, k, copy.deepcopy(v))
    env_saved = {k: os.environ.get(k) for k in (c.get("env") or {})}
    os.environ.update(c.get("env") or {})
    # [FEE-AWARE-SIZE] the trader module's TAKER_FEE overridden / deleted for the case
    fee_saved = {}
    for ex, v in (c.get("taker_fee") or {}).items():
        mod = TRADERS[ex]
        fee_saved[ex] = getattr(mod, "TAKER_FEE", _NODEF)
        if v == "__del__":
            delattr(mod, "TAKER_FEE")
        else:
            mod.TAKER_FEE = v
    ctx_saved = dict(trend_monitor.CTX_RISK)
    trend_monitor.CTX_RISK.update(c.get("ctx_risk") or {})
    CLK.wall = float(c["clock"])
    seed(c)
    before = set(asyncio.all_tasks())
    RECS.clear()
    CAPTURE[0] = True
    results = [None] * len(c["calls"])

    async def one(i, kw, stagger=0.0):
        kw2 = dict(kw)
        kw2["bot"] = BOT_OBJ if kw.get("bot", True) else None
        if stagger:
            # parallel signals arrive 1 ms apart (like ../../wire/py/drive_wire_diff.py): the lock-arrival
            # order is then the call order — aiosqlite's thread timing decided it before (the JS run
            # staggers the same way)
            await asyncio.sleep(stagger)
        try:
            results[i] = {"ok": result_json(await auto_trade.execute_auto_trade(**kw2))}
        except Exception as e:  # noqa: BLE001
            results[i] = {"raised": [type(e).__name__, str(e)]}

    loop = asyncio.get_running_loop()
    if c.get("parallel"):
        ts = [loop.create_task(one(i, kw, i * 0.001), name=f"call{i}") for i, kw in enumerate(c["calls"])]
        await asyncio.gather(*ts)
    else:
        for i, kw in enumerate(c["calls"]):
            await loop.create_task(one(i, kw), name=f"call{i}")
    t_end = CLK.wall
    me = asyncio.current_task()
    while True:
        pend = [t for t in asyncio.all_tasks() if t is not me and t not in before and not t.done()]
        if not pend:
            break
        await asyncio.wait(pend, timeout=3600)
        if CLK.wall - t_end > 7200:
            raise RuntimeError(f"{c['name']}: background tasks still pending: {[t.get_name() for t in pend]}")
    CAPTURE[0] = False
    for k, v in env_saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    for ex, v in fee_saved.items():
        if v is _NODEF:
            if hasattr(TRADERS[ex], "TAKER_FEE"):
                delattr(TRADERS[ex], "TAKER_FEE")
        else:
            TRADERS[ex].TAKER_FEE = v
    trend_monitor.CTX_RISK.clear()
    trend_monitor.CTX_RISK.update(ctx_saved)
    out = {"results": results, "recs": copy.deepcopy(RECS), "clock_end": CLK.wall}
    out.update(dump_db())
    return out


async def main():
    await database.init_db(DBP)
    con = db_conn()
    USER_COLS.extend(r[1] for r in con.execute("PRAGMA table_info(users)"))
    con.close()
    vectors = []
    only = [x for x in os.environ.get("GEN_ONLY", "").split(",") if x]
    for c in CASES:
        if only and c["name"] not in only:
            continue
        _t0 = _REAL_TIME()
        exp = await run_case(c)
        vectors.append({"case": c, "expected": exp})
        print(f"{c['name']}: {_REAL_TIME() - _t0:.2f}s results={exp['results']} recs={len(exp['recs'])}", file=sys.stderr)
    helpers = _helpers() if not only else None
    count_vectors = await _count_vectors() if not only else None
    payload = {"sigs": SIGS, "defaults": DEFAULTS, "user_cols": USER_COLS, "vectors": vectors,
               "taker_fee": {ex: getattr(mod, "TAKER_FEE", None) for ex, mod in TRADERS.items()},
               "helpers": helpers, "count_vectors": count_vectors}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with gzip.open(OUT, "wt", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)   # key order kept: dict insertion order is data
    print(f"wrote {len(vectors)} vectors → {OUT}", file=sys.stderr)


loop = VLoop()
asyncio.set_event_loop(loop)
_rc = 0
try:
    loop.run_until_complete(main())
except BaseException:  # noqa: BLE001 — SystemExit too: aiosqlite threads would block the shutdown
    import traceback
    traceback.print_exc()
    _rc = 1
finally:
    shutil.rmtree(TMP, ignore_errors=True)
sys.stderr.flush()
sys.stdout.flush()
os._exit(_rc)    # aiosqlite's reader threads would keep the interpreter alive
