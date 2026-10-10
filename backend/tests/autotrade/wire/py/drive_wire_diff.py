"""drive_wire_diff.py — adversarial WIRE-LEVEL differential of the bot's auto-trade money path.

The bot's own `auto_trade.execute_auto_trade` runs with the REAL four traders (bybit / bingx /
binance / okx_trader, pybit, partial_tp, plan gate, killswitch, cooldowns, idempotency, prop pilot,
challenge gate, correlation cap, AI filter, tilt detector, admin alerts, telegram_safe, trade_events,
a fresh bot SQLite on a temp file) against STATEFUL fake exchange servers (fake_exchanges.py). Every
HTTP request the bot builds — aiohttp sessions of the traders and pybit's `requests` — is answered
by the simulator and RECORDED with its logical task: method, request target (timestamp / signature
query parameters cut out), body, every header the trader passed (timestamps and signatures
normalised away; the signature is VERIFIED by the simulator: `sig_ok`), the client timeout, the
offset of the request timestamp from the virtual clock, and the answer served (bytes, or a hang /
connection failure). The JS replay (../wireDiff.test.js) serves the same answers, task by task, to
the site's executor + JS traders and compares every request, message, log line, side effect, DB
row and kv value.

Clock: a virtual-time event loop. time.time / time.monotonic / datetime follow one clock that only
moves when nothing is runnable — the loop jumps to its next timer — so wait_for timeouts, pybit
retry sleeps, the bot's 5 s retry and the 60 s / 900 s LIMIT-unfilled grace run instantly and
deterministically. Timers due at the same instant fire in scheduling order (FIFO), like the JS
vclock's `seq` tie-break and the bot on a real clock. pybit runs in executor threads (like
production); a thread's time.sleep / request timeout is a virtual sleep scheduled on the loop, and
the loop never jumps while a thread is runnable.

Scenarios: SEED-driven randomized users (WIRE_SEED, default 20261009 — independent of every other
generator) over the four exchanges: risk modes, leverage, fixed amount, partial TP on/off and its
splits, confirm mode, prop pilot, active challenge with the daily stop hit, correlation cap, kill
switch (user filters_all_off and the global operational state), plan expired, demo, hedge /
one-way accounts, tiny-tick / 1000x / min-notional coins, and injected exchange failures of every
class (insufficient margin, precision, rate limit, timeout after accept, duplicate client order id,
position-mode mismatch, delisted, HTML 5xx, connection refused) — plus one targeted scenario per
(exchange, failure class).

  cd /home/user/MAIN_BOT/CHM_BREAKER_V4
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 $PY311 -I -B <worktree>/backend/tests/autotrade/wire/py/drive_wire_diff.py [OUT]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
Env: WIRE_SEED, WIRE_USERS (random users, default 64), WIRE_ONLY (comma list of scenario names).
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import copy
import dataclasses
import enum
import gzip
import heapq
import inspect
import itertools
import json
import logging
import math
import os
import queue  # noqa: F401  (imported before the clock patch: keeps the real monotonic)
import random as _random
import re
import selectors
import shutil
import sqlite3
import sys
import tempfile
import threading
import types
import urllib.parse

import datetime as _dt
import time as _time

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.normpath(
    os.path.join(HERE, "..", "fixtures", "wire_diff.json.gz"))
SEED = int(os.environ.get("WIRE_SEED", "20261009"))
N_USERS = int(os.environ.get("WIRE_USERS", "64"))
TMP = tempfile.mkdtemp(prefix="m13b_wire_")
DBP = os.path.join(TMP, "bot.db")
os.environ["DB_PATH"] = DBP
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ["ADMIN_IDS"] = "123"
os.environ["NEWS_PROVIDER"] = "none"
os.environ["BYBIT_FERNET_KEY"] = "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="
os.environ["AI_FILTER_ENABLED"] = "1"
for _k in ("LEVELS_HOUR_FILTER_ENABLED", "LEVELS_HOUR_FILTER_MODE", "LEVELS_BAD_HOURS_UTC",
           "SMC_HOUR_FILTER_ENABLED", "SMC_HOUR_FILTER_MODE", "SMC_BAD_HOURS_UTC", "DAILY_MAX_LOSS_R",
           "TREND_CTX_RISK", "SKIP_NOTIFY_THRESHOLD", "SENTRY_DSN", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy",
           "http_proxy", "BYBIT_POS_POLL_MAX_S", "BYBIT_POS_POLL_INTERVAL_S"):
    os.environ.pop(_k, None)
sys.dont_write_bytecode = True
os.chdir(BOT)
sys.path.insert(0, BOT)
sys.path.insert(0, HERE)

import aiosqlite  # noqa: E402
import aiosqlite.core  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import aiohttp  # noqa: E402
import requests  # noqa: E402
import yarl  # noqa: E402
from multidict import CIMultiDict, CIMultiDictProxy  # noqa: E402

import fake_exchanges as FX  # noqa: E402

MAIN_THREAD = threading.current_thread()


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
_REAL_SLEEP = _time.sleep
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


# ── virtual-time event loop (thread aware) ──────────────────────────────────
_IF_LOCK = threading.Lock()
INFLIGHT = [0]
LIVE_THREADS = [0]       # executor jobs submitted and not finished (sleeping or not)
PENDING_IO: dict = {}
PARENT: dict = {}
LOOP: list = [None]
THREAD_TASK = threading.local()


def inflight(d):
    with _IF_LOCK:
        INFLIGHT[0] += d


IDLE_WAITERS: list = []


def _notify_idle():
    """(loop thread) wake the waiters of wait_threads_idle once nothing is in flight and no thread lives."""
    if INFLIGHT[0] == 0 and LIVE_THREADS[0] == 0:
        while IDLE_WAITERS:
            f = IDLE_WAITERS.pop()
            if not f.done():
                f.set_result(None)


async def wait_threads_idle():
    """Wait for the executor threads a wait_for abandoned — exactly until the last one ends (no polling
    step: the clock moves only to the threads' own timers)."""
    loop = asyncio.get_running_loop()
    while INFLIGHT[0] > 0 or LIVE_THREADS[0] > 0:
        f = loop.create_future()
        IDLE_WAITERS.append(f)
        await f


def _track(fut, what):
    inflight(+1)
    PENDING_IO[id(fut)] = what

    def _done(_f):
        inflight(-1)
        PENDING_IO.pop(id(fut), None)
        _notify_idle()
    fut.add_done_callback(_done)


def vsleep(s):
    """time.sleep on the virtual clock. In an executor thread the loop schedules the wake-up;
    while the thread waits it is not counted as in flight (the loop may jump to it)."""
    if s < 0:
        raise ValueError("sleep length must be non-negative")
    lp = LOOP[0]
    if lp is None or threading.current_thread() is MAIN_THREAD:
        CLK.advance(s)
        return
    ev = threading.Event()

    def fire():
        inflight(+1)
        ev.set()
    deadline = CLK.mono + s
    lp.call_soon_threadsafe(lambda: lp.call_at(deadline, fire))
    inflight(-1)
    ev.wait()


_time.sleep = vsleep


class VSelector(selectors.SelectSelector):
    def select(self, timeout=None):
        while True:
            ev = super().select(0)
            if ev or timeout == 0:
                return ev
            if INFLIGHT[0] > 0:
                ev = super().select(0.02)
                if ev:
                    return ev
                self._idle = getattr(self, "_idle", 0) + 1
                if self._idle % 1000 == 0:
                    print(f"[vloop] waiting on {INFLIGHT[0]} in-flight: {list(PENDING_IO.values())[:3]}", file=sys.stderr)
                continue
            # a thread that just went to sleep wrote its wake-up request to the self-pipe BEFORE it
            # stopped counting as in flight: look once more before jumping the clock
            ev = super().select(0)
            if ev:
                return ev
            self._idle = 0
            lp = LOOP[0]
            sched = getattr(lp, "_scheduled", None)
            if timeout is not None and sched:
                # jump EXACTLY to the next timer (mono = when, wall += when - mono) like the JS clock; timers due
                # at the same instant then fire in scheduling order on both clocks (_FifoTimerHandle)
                when = sched[0].when()
                if when > CLK.mono:
                    CLK.wall += when - CLK.mono
                    CLK.mono = when
                return []
            if timeout is None:
                lp = LOOP[0]
                for t in (asyncio.all_tasks(lp) if lp else []):
                    print(f"[deadlock] task {t.get_name()}:", file=sys.stderr)
                    t.print_stack(limit=8, file=sys.stderr)
                print(f"[deadlock] INFLIGHT={INFLIGHT[0]} pending_io={list(PENDING_IO.values())}", file=sys.stderr)
                import traceback as _tb
                frames = sys._current_frames()
                for th in threading.enumerate():
                    if th.name.startswith("vexec"):
                        print(f"[deadlock] thread {th.name}:", file=sys.stderr)
                        f = frames.get(th.ident)
                        if f is not None:
                            print("".join(_tb.format_stack(f, limit=12)), file=sys.stderr)
                raise RuntimeError("virtual loop: idle with no timers (deadlock)")
            CLK.advance(timeout)
            return []


_TIMER_SEQ = itertools.count()


class _FifoTimerHandle(asyncio.TimerHandle):
    """A TimerHandle that breaks an equal-`when` tie by scheduling order — the JS vclock's `seq`, and what a
    real clock gives the bot (two timers practically never share an instant there). CPython's TimerHandle
    compares `_when` only and heapq does not keep ties FIFO."""

    __slots__ = ("_seq",)

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self._seq = next(_TIMER_SEQ)

    def __lt__(self, other):
        if isinstance(other, _FifoTimerHandle):
            return (self._when, self._seq) < (other._when, other._seq)
        return super().__lt__(other)

    def __le__(self, other):
        if isinstance(other, _FifoTimerHandle):
            return (self._when, self._seq) <= (other._when, other._seq)
        return super().__le__(other)

    def __gt__(self, other):
        if isinstance(other, _FifoTimerHandle):
            return (self._when, self._seq) > (other._when, other._seq)
        return super().__gt__(other)

    def __ge__(self, other):
        if isinstance(other, _FifoTimerHandle):
            return (self._when, self._seq) >= (other._when, other._seq)
        return super().__ge__(other)


class VLoop(asyncio.SelectorEventLoop):
    def __init__(self):
        super().__init__(selector=VSelector())
        self.set_default_executor(concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="vexec"))

    def time(self):
        return CLK.mono

    def call_at(self, when, callback, *args, context=None):
        """CPython 3.11 BaseEventLoop.call_at with a _FifoTimerHandle: timers due at the same instant fire in
        scheduling order (FIFO), like the JS vclock (call_later, asyncio.sleep, wait_for and vsleep's
        executor-thread timers all come through here)."""
        if when is None:
            raise TypeError("when cannot be None")
        self._check_closed()
        if self._debug:
            self._check_thread()
            self._check_callback(callback, 'call_at')
        timer = _FifoTimerHandle(when, callback, args, self, context)
        if timer._source_traceback:
            del timer._source_traceback[-1]
        heapq.heappush(self._scheduled, timer)
        timer._scheduled = True
        return timer

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
        """Track the THREAD (the concurrent future), not the asyncio wrapper: a wait_for timeout cancels
        the wrapper while the pybit call keeps running in its thread (the bot's shielded calls)."""
        tname = task_name()

        def wrapped(*a):
            THREAD_TASK.name = tname
            try:
                return func(*a)
            finally:
                THREAD_TASK.name = None
        if executor is None:
            executor = self._default_executor
        inflight(+1)
        with _IF_LOCK:
            LIVE_THREADS[0] += 1
        key = object()
        PENDING_IO[id(key)] = f"executor {func!r}"[:120]
        cf = executor.submit(wrapped, *args)
        fut = asyncio.wrap_future(cf, loop=self)

        def _thread_done(_f):
            def _dec():
                inflight(-1)
                with _IF_LOCK:
                    LIVE_THREADS[0] -= 1
                PENDING_IO.pop(id(key), None)
                _notify_idle()
            try:
                self.call_soon_threadsafe(_dec)
            except RuntimeError:
                _dec()
        cf.add_done_callback(_thread_done)
        return fut


_orig_conn_init = aiosqlite.core.Connection.__init__


def _conn_init(self, *a, **k):
    _orig_conn_init(self, *a, **k)
    q = self._tx

    class _TxProxy:
        def put_nowait(_s, item):
            if item is not aiosqlite.core._STOP_RUNNING_SENTINEL:
                _track(item[0], f"sqlite {item[1]!r}"[:160])
            q.put_nowait(item)

        def get(_s, *aa, **kk):
            return q.get(*aa, **kk)

    self._tx = _TxProxy()


aiosqlite.core.Connection.__init__ = _conn_init
_DEFAULT_TASK = re.compile(r"^Task-\d+$")


def task_name():
    tn = getattr(THREAD_TASK, "name", None)
    if threading.current_thread() is not MAIN_THREAD:
        return tn or "thread"
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
_REC_LOCK = threading.Lock()


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
        with _REC_LOCK:
            RECS.append([task_name(), kind, jsonable(data)])


TRADER_LOGGERS = ("CHM.Bybit", "CHM.BingX", "CHM.Binance", "CHM.OKX.Trader", "CHM.ApiRetry", "CHM.ExchangeBreaker")
MARKER_RE = re.compile(r"\[[A-Z][A-Z0-9_-]*[A-Z0-9]\]")
LOG_ALLOW = [None]       # routes mode: the handler loggers whose lines are recorded (None = every logger)


class Cap(logging.Handler):
    def emit(self, r):
        if not CAPTURE[0] or r.levelno < logging.INFO:
            return
        if r.name.startswith("pybit") or r.name.startswith("urllib3") or r.name.startswith("asyncio") or r.name.startswith("aiosqlite"):
            return
        try:
            msg = r.getMessage()
        except Exception:  # noqa: BLE001
            msg = str(r.msg)
        if msg.startswith("[TG-SAFE]"):
            return
        with _REC_LOCK:
            if r.name in TRADER_LOGGERS:
                ms = MARKER_RE.findall(msg)
                if ms:
                    RECS.append([task_name(), "tlog", [r.levelname, ms]])
            elif LOG_ALLOW[0] is None or r.name in LOG_ALLOW[0]:
                RECS.append([task_name(), "log", [r.levelname, msg]])


logging.getLogger().addHandler(Cap())
logging.getLogger().setLevel(logging.INFO)
for _ln in TRADER_LOGGERS:
    logging.getLogger(_ln).setLevel(logging.DEBUG)

# ── bot modules ─────────────────────────────────────────────────────────────
import database  # noqa: E402
import db.stats as db_stats  # noqa: E402
import auto_trade  # noqa: E402
import bybit_trader as by  # noqa: E402
import bingx_trader as bx  # noqa: E402
import binance_trader as bn  # noqa: E402
import okx_trader as ok  # noqa: E402
import partial_tp  # noqa: E402
import cache  # noqa: E402
import exchange_symbols  # noqa: E402
import challenge  # noqa: E402
import user_logger  # noqa: E402
import funnel_tracker  # noqa: E402
import metrics as metrics_mod  # noqa: E402
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
import admin_alerts  # noqa: E402,F401
import ai_filter  # noqa: E402,F401
import handlers.ai_insights  # noqa: E402,F401
import risk_preview  # noqa: E402,F401
import prop_pilot  # noqa: E402,F401
import adaptive_sizing  # noqa: E402,F401
import trend_monitor  # noqa: E402,F401
import telegram_safe  # noqa: E402,F401
import api_retry  # noqa: E402
import exchange_breaker  # noqa: E402
import fetcher_bingx  # noqa: E402
import pybit._http_manager as pyhttp  # noqa: E402
import defense.killswitch as ks  # noqa: E402
from config import Config  # noqa: E402

TRADERS = {"bybit": by, "bingx": bx, "binance": bn, "okx": ok}

# ── fake HTTP layers → the simulator ─────────────────────────────────────────
SIM: list = [None]
DROP_HDRS = {"host", "user-agent", "accept-encoding", "connection", "content-length"}
TS_HDRS = {"x-bapi-timestamp", "ok-access-timestamp"}
SIG_HDRS = {"x-bapi-sign", "ok-access-sign"}
_TS_Q = re.compile(r"(^|&)(timestamp|signature)=[^&]*")
_IP = "203.0.113.10"


def _okx_iso_ms(s):
    try:
        return int(_dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=_dt.timezone.utc).timestamp() * 1000 + 0.5)
    except Exception:  # noqa: BLE001
        return None


def norm_request(method, url, headers, body, timeout_s, client):
    """The comparable shape of one request (timestamps / signatures out, their facts kept)."""
    u = urllib.parse.urlsplit(url)
    q = u.query
    ts_ms = None
    m = re.search(r"(?:^|&)timestamp=(\d+)", q)
    if m:
        ts_ms = int(m.group(1))
    has_sig = bool(re.search(r"(?:^|&)signature=", q))
    q2 = _TS_Q.sub("", q).lstrip("&")
    hdrs = {}
    for k, v in (headers or {}).items():
        kl = k.lower()
        if kl in DROP_HDRS:
            continue
        if kl in TS_HDRS:
            ts_ms = int(v) if kl == "x-bapi-timestamp" and str(v).isdigit() else _okx_iso_ms(str(v))
            hdrs[kl] = "<ts>"
            continue
        if kl in SIG_HDRS:
            hdrs[kl] = "<sig>"
            continue
        hdrs[kl] = v
    target = u.path + ("?" + q2 if q2 else "")
    return {
        "method": method, "origin": f"{u.scheme}://{u.netloc}", "target": target,
        "body": body if body not in (None, b"", "") else None,
        "headers": dict(sorted(hdrs.items())), "qsig": has_sig,
        "ts_delta": None if ts_ms is None else ts_ms - int(round(CLK.wall * 1000)),
        "timeout": timeout_s, "client": client,
    }


def exchange_call(method, url, headers, body, timeout_s, client):
    """→ (served dict, record). served = {status, headers, text} | {hang} | {connect}."""
    sim = SIM[0]
    out = sim.handle(method, url, headers, body) if sim is not None else {"status": 404, "headers": {}, "text": "no sim"}
    req = norm_request(method, url, headers, body, timeout_s, client)
    req["sig_ok"] = out.get("sig_ok")
    host = urllib.parse.urlsplit(url).hostname or ""
    if out.get("connect"):
        pq = urllib.parse.urlsplit(url)
        path_qs = pq.path + ("?" + pq.query if pq.query else "")
        served = {"connect": {
            "aio": f"Cannot connect to host {host}:443 ssl:default [Connect call failed ('{_IP}', 443)]",
            "req": (f"HTTPSConnectionPool(host='{host}', port=443): Max retries exceeded with url: {path_qs} "
                    f"(Caused by NewConnectionError(\"HTTPSConnection(host='{host}', port=443): Failed to establish a new "
                    f"connection: [Errno 111] Connection refused\"))")}}
    elif out.get("hang"):
        served = {"hang": True}
    else:
        served = {"status": out["status"], "headers": out.get("headers") or {}, "text": out.get("text", "")}
        if out.get("delay"):
            served["delay"] = out["delay"]
    if out.get("unhandled"):
        req["unhandled"] = True
    rec("req", {"req": req, "resp": served, "fault": out.get("fault")})
    return served


class _AioResp:
    def __init__(self, served, url, method):
        self.status = served["status"]
        self.reason = "OK" if self.status == 200 else "ERR"
        h = CIMultiDict()
        for k, v in (served.get("headers") or {}).items():
            h[k] = v
        self.headers = CIMultiDictProxy(h)
        self._text = served.get("text", "")
        self.url = yarl.URL(url) if isinstance(url, str) else url
        self.method = method
        self.content_type = (self.headers.get("Content-Type", "") or "").split(";")[0].strip().lower()

    async def text(self, encoding=None, errors="strict"):
        return self._text

    async def read(self):
        return self._text.encode()

    async def json(self, *, encoding=None, loads=json.loads, content_type="application/json"):
        if content_type:
            ctype = (self.headers.get("Content-Type", "") or "").lower()
            if not re.match(r"^application/(?:[\w.+-]+?\+)?json", ctype):
                ri = aiohttp.RequestInfo(url=self.url, method=self.method, headers=CIMultiDictProxy(CIMultiDict()), real_url=self.url)
                raise aiohttp.ContentTypeError(ri, (), status=self.status,
                                               message="Attempt to decode JSON with unexpected mimetype: %s" % ctype)
        stripped = self._text.strip()
        if not stripped:
            return None
        return loads(stripped)

    def raise_for_status(self):
        if self.status >= 400:
            ri = aiohttp.RequestInfo(url=self.url, method=self.method, headers=CIMultiDictProxy(CIMultiDict()), real_url=self.url)
            raise aiohttp.ClientResponseError(ri, (), status=self.status, message=self.reason, headers=self.headers)

    def release(self):
        pass

    def close(self):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _CCE(aiohttp.ClientConnectorError):
    def __init__(self, m):
        Exception.__init__(self, m)
        self._m = m

    def __str__(self):
        return self._m


class _ReqCtx:
    def __init__(self, sess, method, url, kw):
        self.sess, self.method, self.url, self.kw = sess, method, url, kw
        self._resp = None

    async def _go(self):
        kw = self.kw
        u = self.url if isinstance(self.url, yarl.URL) else yarl.URL(str(self.url))
        params = kw.get("params")
        if params:
            u = u.extend_query(params)
        headers = dict(kw.get("headers") or {})
        body = None
        if kw.get("json") is not None:
            body = json.dumps(kw["json"])
            if not any(k.lower() == "content-type" for k in headers):
                headers["Content-Type"] = "application/json"
        elif kw.get("data") is not None:
            d = kw["data"]
            if isinstance(d, (bytes, bytearray)):
                body = bytes(d).decode()
            elif isinstance(d, str):
                body = d
            elif isinstance(d, dict):
                body = urllib.parse.urlencode(d)
            else:
                body = str(d)
        to = kw.get("timeout", None)
        if isinstance(to, aiohttp.ClientTimeout):
            total = to.total
        elif isinstance(to, (int, float)):
            total = float(to)
        else:
            total = self.sess.default_total
        served = exchange_call(self.method, str(u), headers, body, total, "aiohttp")
        await asyncio.sleep(0)
        if "hang" in served or (served.get("delay") and total and served["delay"] >= total):
            await asyncio.sleep(total if total else 10 ** 7)
            raise asyncio.TimeoutError()
        if "connect" in served:
            raise _CCE(served["connect"]["aio"])
        if served.get("delay"):
            await asyncio.sleep(served["delay"])
        return _AioResp(served, str(u), self.method)

    def __await__(self):
        return self._go().__await__()

    async def __aenter__(self):
        self._resp = await self._go()
        return self._resp

    async def __aexit__(self, *a):
        return False


class FakeAioSession:
    closed = False

    def __init__(self, default_total=15.0):
        self.default_total = default_total

    def request(self, method, url, **kw):
        return _ReqCtx(self, method.upper(), url, kw)

    def get(self, url, **kw):
        return _ReqCtx(self, "GET", url, kw)

    def post(self, url, **kw):
        return _ReqCtx(self, "POST", url, kw)

    def delete(self, url, **kw):
        return _ReqCtx(self, "DELETE", url, kw)

    def put(self, url, **kw):
        return _ReqCtx(self, "PUT", url, kw)

    async def close(self):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


_SESS = {"bybit": FakeAioSession(15.0), "bingx": FakeAioSession(15.0), "binance": FakeAioSession(15.0), "okx": FakeAioSession(15.0)}


def _mk_gs(ex):
    async def _gs():
        return _SESS[ex]
    return _gs


for _ex, _mod in TRADERS.items():
    _mod._get_http_session = _mk_gs(_ex)
_aio_ns = types.SimpleNamespace(**{k: getattr(aiohttp, k) for k in dir(aiohttp) if not k.startswith("__")})
_aio_ns.ClientSession = lambda *a, **k: FakeAioSession((k.get("timeout").total if isinstance(k.get("timeout"), aiohttp.ClientTimeout) else 15.0))
bn.aiohttp = _aio_ns


async def _reset_noop():
    return None
by._reset_http_session = _reset_noop
by._prewarm_dns = lambda host: None


def _requests_send(self, request, **kwargs):
    body = request.body
    if isinstance(body, bytes):
        body = body.decode()
    to = kwargs.get("timeout")
    if isinstance(to, tuple):
        to = to[1]
    served = exchange_call(request.method, request.url, dict(request.headers), body, to, "requests")
    if "hang" in served or (served.get("delay") and to and served["delay"] >= float(to)):
        vsleep(float(to or 10))
        host = urllib.parse.urlsplit(request.url).hostname
        raise requests.exceptions.ReadTimeout(f"HTTPSConnectionPool(host='{host}', port=443): Read timed out. (read timeout={to})")
    if "connect" in served:
        raise requests.exceptions.ConnectionError(served["connect"]["req"])
    if served.get("delay"):
        vsleep(served["delay"])
    resp = requests.models.Response()
    resp.status_code = served["status"]
    resp.headers = requests.structures.CaseInsensitiveDict(served.get("headers") or {})
    resp._content = served.get("text", "").encode()
    resp.encoding = "utf-8"
    resp.url = request.url
    resp.request = request
    resp.elapsed = _dt.timedelta(0)
    return resp


requests.Session.send = _requests_send
pyhttp.dt = FakeDT


class _Rand:
    def uniform(self, a, b):
        return a + (b - a) * 0.5

    def random(self):
        return 0.5


api_retry.random = _Rand()

# ── collaborators recorded as side effects (the JS harness mirrors each hook) ──
CASE: dict = {}


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


async def fake_metric(name, value=1.0, tags=None):
    rec("metric", [name, value, tags])


metrics_mod.record = fake_metric


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
    return frame_of((CASE.get("candles") or {}).get(f"{symbol}|{tf}"))


cache.get_candles = fake_get_candles
database.db_get_today_loss_rr = swap_dt(db_stats.db_get_today_loss_rr)
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

# ══════════════════════════ scenario generation ══════════════════════════
T0 = 1767781800.0          # 2026-01-07 10:30:00 UTC (Wednesday)

# OKX-format coins: price / tick in OKX units, qty step in coins, OKX contract value + lot
COINS = {
    "BTC-USDT-SWAP": dict(price=87250.5, tick=0.1, step=0.001, bx_step=0.0001, ct_val=0.01, lot_sz=0.01, max_lev=100),
    "ETH-USDT-SWAP": dict(price=3010.25, tick=0.01, step=0.01, bx_step=0.01, ct_val=0.1, lot_sz=0.01, max_lev=100),
    "SOL-USDT-SWAP": dict(price=148.37, tick=0.01, step=0.1, bx_step=0.1, ct_val=1, lot_sz=0.01, max_lev=75),
    "XRP-USDT-SWAP": dict(price=2.1534, tick=0.0001, step=1, bx_step=1, ct_val=100, lot_sz=0.1, max_lev=75),
    "DOGE-USDT-SWAP": dict(price=0.18234, tick=0.00001, step=1, bx_step=1, ct_val=1000, lot_sz=0.1, max_lev=75),
    "PEPE-USDT-SWAP": dict(price=0.00000912, tick=0.00000001, step=100000, bx_step=100000, ct_val=10000000, lot_sz=0.1, max_lev=50),
    "SHIB-USDT-SWAP": dict(price=0.00001234, tick=0.00000001, step=100000, bx_step=100000, ct_val=1000000, lot_sz=1, max_lev=50),
    "FLOKI-USDT-SWAP": dict(price=0.00008456, tick=0.00000001, step=10000, bx_step=10000, ct_val=100000, lot_sz=1, max_lev=50),
    "SATS-USDT-SWAP": dict(price=0.0000002345, tick=0.0000000001, step=10000000, bx_step=10000000, ct_val=10000000, lot_sz=1, max_lev=25),
    "TINY-USDT-SWAP": dict(price=0.0003127, tick=0.0000001, step=1000, bx_step=1000, ct_val=1000, lot_sz=1, max_lev=25),
    "AVAX-USDT-SWAP": dict(price=29.674, tick=0.001, step=0.1, bx_step=0.1, ct_val=1, lot_sz=0.1, max_lev=50),
    "LINK-USDT-SWAP": dict(price=13.457, tick=0.001, step=0.1, bx_step=0.1, ct_val=1, lot_sz=0.1, max_lev=50),
    "DLST-USDT-SWAP": dict(price=1.2345, tick=0.0001, step=1, bx_step=1, ct_val=10, lot_sz=1, max_lev=20, status="Closed"),
}


def _native(ex, sym):
    if ex == "bybit":
        return by.to_bybit_symbol(sym), by.bybit_price_multiplier(sym)
    if ex == "bingx":
        return bx.to_bingx_symbol(sym), bx.bingx_price_multiplier(sym)
    if ex == "binance":
        return bn.to_binance_symbol(sym), bn.binance_price_multiplier(sym)
    return ok.to_okx_symbol(sym), 1.0


def _clean(x):
    return float(f"{x:.12g}")


def build_instruments(prices=None):
    out = {}
    for ex in ("bybit", "bingx", "binance", "okx"):
        d = {}
        for sym, c in COINS.items():
            native, pm = _native(ex, sym)
            price = (prices or {}).get(sym, c["price"])
            i = {"price": _clean(price * pm), "tick": _clean(c["tick"] * pm),
                 "step": _clean((c["bx_step"] if ex == "bingx" else c["step"]) / pm),
                 "max_lev": c["max_lev"], "funding": c.get("funding", 0.0001), "spread": 2,
                 "status": c.get("status", "Trading")}
            if ex == "okx":
                i["ct_val"] = c["ct_val"]
                i["lot_sz"] = c["lot_sz"]
                i["step"] = c["lot_sz"]
            d[native] = i
        out[ex] = d
    return out


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
        out.append([start_ms + i * tf_ms, float(f"{o:.10g}"), float(f"{h:.10g}"), float(f"{lo:.10g}"), float(f"{c:.10g}"), 1000.0 + i])
        p = c
    return out


# exchange error replies (what the live exchanges answer for each class)
def bybit_err(code, msg):
    return {"retCode": code, "retMsg": msg, "result": {}, "retExtInfo": {}, "time": 1767781800000}


ERRORS = {
    "bybit": {
        "insufficient_margin": ("POST", "/v5/order/create", {"json": bybit_err(110007, "ab not enough for new order")}),
        "precision": ("POST", "/v5/order/create", {"json": bybit_err(10001, "Qty invalid")}),
        "rate_limit": ("POST", "/v5/order/create", {"json": bybit_err(10006, "Too many visits!"),
                                                    "headers": {"X-Bapi-Limit-Reset-Timestamp": "$RESET_MS"}}),
        "rate_limit_balance": ("GET", "/v5/account/wallet-balance", {"json": bybit_err(10006, "Too many visits!")}),
        "duplicate": ("POST", "/v5/order/create", {"json": bybit_err(110072, "OrderLinkedID is duplicate")}),
        "position_mode": ("POST", "/v5/order/create", {"json": bybit_err(10001, "position idx not match position mode")}),
        "delisted": ("POST", "/v5/order/create", {"json": bybit_err(110074, "This contract is not live")}),
        "auth": ("POST", "/v5/order/create", {"json": bybit_err(10003, "API key is invalid.")}),
        "tpsl_param": ("POST", "/v5/order/create", {"json": bybit_err(10001, "TakeProfit:0 set for Buy position should be higher than base_price")}),
    },
    "bingx": {
        "insufficient_margin": ("POST", "/openApi/swap/v2/trade/order", {"json": {"code": 101204, "msg": "Insufficient margin", "data": {}}}),
        "precision": ("POST", "/openApi/swap/v2/trade/order", {"json": {"code": 80001, "msg": "quantity precision is invalid", "data": {}}}),
        "rate_limit": ("POST", "/openApi/swap/v2/trade/order", {"status": 429, "json": {"code": 100410, "msg": "rate limit exceeded", "data": {}}}),
        "rate_limit_balance": ("GET", "/openApi/swap/v2/user/balance", {"status": 429, "json": {"code": 100410, "msg": "rate limit exceeded", "data": {}}}),
        "duplicate": ("POST", "/openApi/swap/v2/trade/order", {"json": {"code": 101404, "msg": "duplicate clientOrderId", "data": {}}}),
        "position_mode": ("POST", "/openApi/swap/v2/trade/order", {"json": {"code": 109400, "msg": "In the One-way mode, the 'PositionSide' field can only be set to BOTH", "data": {}}}),
        "delisted": ("POST", "/openApi/swap/v2/trade/order", {"json": {"code": 109414, "msg": "trading pair is suspended", "data": {}}}),
        "auth": ("GET", "/openApi/swap/v2/user/balance", {"json": {"code": 100413, "msg": "Incorrect apiKey", "data": {}}}),
        "tp_rejected": ("POST", "/openApi/swap/v2/trade/order", {"json": {"code": 110413, "msg": "TP price should be higher than mark price", "data": {}}}),
    },
    "binance": {
        "insufficient_margin": ("POST", "/fapi/v1/order", {"status": 400, "json": {"code": -2019, "msg": "Margin is insufficient."}}),
        "precision": ("POST", "/fapi/v1/order", {"status": 400, "json": {"code": -1111, "msg": "Precision is over the maximum defined for this asset."}}),
        "rate_limit": ("POST", "/fapi/v1/order", {"status": 429, "json": {"code": -1003, "msg": "Too many requests; current limit is 2400 requests per minute."}}),
        "rate_limit_balance": ("GET", "/fapi/v2/balance", {"status": 429, "json": {"code": -1003, "msg": "Too many requests"}}),
        "duplicate": ("POST", "/fapi/v1/order", {"status": 400, "json": {"code": -4015, "msg": "Client order id is not valid."}}),
        "position_mode": ("POST", "/fapi/v1/order", {"status": 400, "json": {"code": -4061, "msg": "Order's position side does not match user's setting."}}),
        "delisted": ("POST", "/fapi/v1/order", {"status": 400, "json": {"code": -4140, "msg": "Invalid symbol status for opening position."}}),
        "auth": ("GET", "/fapi/v2/balance", {"status": 401, "json": {"code": -2015, "msg": "Invalid API-key, IP, or permissions for action."}}),
        "batch_error": ("POST", "/fapi/v1/batchOrders", {"status": 400, "json": {"code": -1102, "msg": "Mandatory parameter 'batchOrders' was not sent, was empty/null, or malformed."}}),
    },
    "okx": {
        "insufficient_margin": ("POST", "/api/v5/trade/order", {"json": {"code": "1", "msg": "All operations failed", "data": [
            {"ordId": "", "clOrdId": "", "sCode": "51008", "sMsg": "Order failed. Insufficient USDT margin in account"}]}}),
        "precision": ("POST", "/api/v5/trade/order", {"json": {"code": "1", "msg": "All operations failed", "data": [
            {"ordId": "", "clOrdId": "", "sCode": "51121", "sMsg": "Order quantity must be a multiple of the lot size."}]}}),
        "rate_limit": ("POST", "/api/v5/trade/order", {"status": 429, "json": {"code": "50011", "msg": "Rate limit reached. Please refer to API documentation and throttle requests accordingly.", "data": []}}),
        "rate_limit_balance": ("GET", "/api/v5/account/balance", {"json": {"code": "50011", "msg": "Too Many Requests", "data": []}}),
        "duplicate": ("POST", "/api/v5/trade/order", {"json": {"code": "1", "msg": "All operations failed", "data": [
            {"ordId": "", "clOrdId": "", "sCode": "51016", "sMsg": "Duplicated clOrdId"}]}}),
        "position_mode": ("POST", "/api/v5/trade/order", {"json": {"code": "1", "msg": "All operations failed", "data": [
            {"ordId": "", "clOrdId": "", "sCode": "51000", "sMsg": "Parameter posSide error"}]}}),
        "delisted": ("POST", "/api/v5/trade/order", {"json": {"code": "51001", "msg": "Instrument ID doesn't exist.", "data": []}}),
        "auth": ("GET", "/api/v5/account/balance", {"json": {"code": "50113", "msg": "Invalid Sign", "data": []}}),
        "attach_algo": ("POST", "/api/v5/trade/order", {"json": {"code": "1", "msg": "All operations failed", "data": [
            {"ordId": "", "clOrdId": "", "sCode": "51000", "sMsg": "Parameter attachAlgoOrds error"}]}}),
    },
}
ERRORS["bybit"].update({
    "tp_reduce_race": ("POST", "/v5/order/create", {"json": bybit_err(110017, "current position is zero, cannot fix reduce-only order qty")}),
    "trading_stop_zero": ("POST", "/v5/position/trading-stop", {"json": bybit_err(10001, "can not set tp/sl/ts for zero position")}),
    "leverage_perm": ("POST", "/v5/position/set-leverage", {"json": bybit_err(10005, "Permission denied, please check your API key permissions.")}),
    "wallet_contract": ("GET", "/v5/account/wallet-balance", {"json": bybit_err(10001, "accountType only support UNIFIED.")}),
})
ERRORS["bingx"].update({
    "sl_rejected": ("POST", "/openApi/swap/v2/trade/order", {"json": {"code": 101400, "msg": "The stop price is invalid", "data": {}}}),
    "no_position_tp": ("POST", "/openApi/swap/v2/trade/order", {"json": {"code": 101205, "msg": "No position to close", "data": {}}}),
    "leverage_oneway": ("POST", "/openApi/swap/v2/trade/leverage", {"json": {"code": 109400, "msg": "In the One-way mode, the 'PositionSide' field can only be set to BOTH", "data": {}}}),
})
ERRORS["binance"].update({
    "tp_immediate": ("POST", "/fapi/v1/order", {"status": 400, "json": {"code": -2021, "msg": "Order would immediately trigger."}}),
    "leverage_invalid": ("POST", "/fapi/v1/leverage", {"status": 400, "json": {"code": -4028, "msg": "Leverage 20 is not valid"}}),
    "dual_existing": ("POST", "/fapi/v1/positionSide/dual", {"status": 400, "json": {"code": -4068, "msg": "Position side cannot be changed if there exists position."}}),
})
ERRORS["okx"].update({
    "algo_reject": ("POST", "/api/v5/trade/order-algo", {"json": {"code": "1", "msg": "", "data": [
        {"algoId": "", "sCode": "51277", "sMsg": "TP trigger price cannot be higher than the last price"}]}}),
    "close_fail": ("POST", "/api/v5/trade/close-position", {"json": {"code": "51023", "msg": "Position does not exist", "data": []}}),
    "leverage_fail": ("POST", "/api/v5/account/set-leverage", {"json": {"code": "51000", "msg": "Parameter lever error", "data": []}}),
})
SLOW_PATHS = {
    "bybit": (["/v5/position/switch-isolated", "/v5/position/set-leverage", "/v5/account/wallet-balance"], 9.5),
    "bingx": (["/openApi/swap/v2/user/balance", "/openApi/swap/v2/trade/leverage", "/openApi/swap/v2/trade/batchOrders"], 14.5),
    "binance": (["/fapi/v2/balance", "/fapi/v1/positionSide/dual", "/fapi/v1/leverage"], 14.5),
    "okx": (["/api/v5/public/instruments", "/api/v5/account/balance", "/api/v5/account/set-leverage"], 14.5),
}
SLOW_ENTRY_EXTRA = {"binance": ["/fapi/v1/order"], "bingx": ["/openApi/swap/v2/user/positions"]}
TARGET_NTH = {"tp_reduce_race": 2, "tp_rejected": 3, "sl_rejected": 2, "no_position_tp": 3}
EXTRA_CLASSES = {
    "bybit": ["tpsl_param", "tp_reduce_race", "trading_stop_zero", "leverage_perm", "wallet_contract"],
    "bingx": ["tp_rejected", "sl_rejected", "no_position_tp", "leverage_oneway"],
    "binance": ["batch_error", "batch_sl_reject", "tp_immediate", "leverage_invalid", "dual_existing"],
    "okx": ["attach_algo", "algo_reject", "close_fail", "leverage_fail"],
}
ENTRY_PATH = {"bybit": ("POST", "/v5/order/create"), "bingx": ("POST", "/openApi/swap/v2/trade/order"),
              "binance": ("POST", "/fapi/v1/batchOrders"), "okx": ("POST", "/api/v5/trade/order")}
POS_PATH = {"bybit": ("GET", "/v5/position/list"), "bingx": ("GET", "/openApi/swap/v2/user/positions"),
            "binance": ("GET", "/fapi/v2/positionRisk"), "okx": ("GET", "/api/v5/account/positions")}
PRICE_PATH = {"bybit": ("GET", "/v5/market/tickers"), "bingx": ("GET", "/openApi/swap/v2/quote/price"),
              "binance": ("GET", "/fapi/v1/ticker/price"), "okx": ("GET", "/api/v5/market/ticker")}


def fault(ex, cls, nth=1, kind="resp"):
    if cls in ("timeout_after_accept", "timeout_before_accept"):
        m, p = ENTRY_PATH[ex]
        if ex == "binance":
            p = "/fapi/v1/order" if cls == "timeout_before_accept" else "/fapi/v1/batchOrders"
        return {"ex": ex, "method": m, "path": p, "nth": nth, "kind": "hang_accept" if cls == "timeout_after_accept" else "hang",
                "label": cls}
    if cls == "html_502":
        m, p = ENTRY_PATH[ex]
        return {"ex": ex, "method": m, "path": p, "nth": nth, "kind": "status", "status": 502, "label": cls}
    if cls == "connect":
        m, p = POS_PATH[ex]
        return {"ex": ex, "method": m, "path": p, "nth": nth, "kind": "connect", "label": cls}
    if cls == "price_timeout":
        m, p = PRICE_PATH[ex]
        return {"ex": ex, "method": m, "path": p, "nth": nth, "kind": "hang", "label": cls}
    if cls == "batch_sl_reject":
        # Binance atomic batch: the entry fills, the STOP_MARKET item is refused
        return {"ex": ex, "method": "POST", "path": "/fapi/v1/batchOrders", "nth": nth, "kind": "batch_item", "label": cls,
                "items": {"1": {"code": -2021, "msg": "Order would immediately trigger."}}}
    m, p, r = ERRORS[ex][cls]
    f = {"ex": ex, "method": m, "path": p, "nth": nth, "kind": kind, "json": r["json"], "label": cls}
    if "status" in r:
        f["status"] = r["status"]
    if "headers" in r:
        f["headers"] = r["headers"]
    return f


KEYS = {
    "bybit": ("BYKEY{uid}abcdef12345", "by-secret-{uid}-Qw3rty", ""),
    "bingx": ("BXKEY{uid}abcdef12345", "bx-secret-{uid}-Qw3rty", ""),
    "binance": ("BNKEY{uid}abcdef12345", "bn-secret-{uid}-Qw3rty", ""),
    "okx": ("OKKEY{uid}abcdef12345", "ok-secret-{uid}-Qw3rty", "Pass#{uid}"),
}

SCENARIOS: list = []


def trade_row(uid, tid, created, **o):
    r = {"trade_id": tid, "user_id": uid, "symbol": "SOL-USDT-SWAP", "direction": "LONG", "entry": 100.0,
         "sl": 98.0, "tp1": 103.0, "tp2": 106.0, "tp3": 109.0, "result": "", "result_rr": 0.0,
         "created_at": created, "order_id": "", "state": "PENDING", "strategy": "LEVELS",
         "tp_placed": 0, "qty": 0.0}
    r.update(o)
    return r


def make_signal(rng, sym, direction, strategy, *, price, drift=0.0, sl_pct=None, rr=(1.0, 2.0, 3.0), tick=None):
    """A signal near the live price: entry = price × (1 + drift); SL sl_pct away; TPs at R multiples."""
    sl_pct = sl_pct if sl_pct is not None else rng.choice([0.004, 0.008, 0.012, 0.02, 0.035, 0.06])
    entry = price * (1 + drift)
    sgn = 1 if direction == "LONG" else -1
    risk = entry * sl_pct
    sl = entry - sgn * risk

    def q(x):
        return float(f"{x:.8g}")
    sig = {"entry": q(entry), "sl": q(sl), "tp1": q(entry + sgn * risk * rr[0]), "tp2": q(entry + sgn * risk * rr[1]),
           "tp3": q(entry + sgn * risk * rr[2]) if rr[2] else 0.0}
    if strategy == "SMC":
        sig["entry_low"] = q(entry * (1 - 0.002))
        sig["entry_high"] = q(entry * (1 + 0.002))
        sig["entry"] = sig["entry_low"]
    return sig


def scenario(name, *, uid, ex, user=None, signals, rng=None, balance=1000.0, avail=None, hedge=None, faults=None,
             trades=None, kv=None, ks_state=None, regime="ranging", candles=None, state=None, clock=T0, prices=None,
             challenge_rec=None, symbol_ok=True, mutation_info=None, send_fail=None, parallel=False, demo=False, keys=None,
             gap=0.0, env=None, config=None, moves=None, bx_batch=None):
    k = keys or {ex: tuple(s.format(uid=uid) for s in KEYS[ex])}
    u = {"user_id": uid, "username": f"user{uid}", "sub_plan": "pro", "sub_status": "active", "sub_expires": clock + 30 * 86400,
         "lang": "ru", "auto_trade": 1, "auto_trade_mode": "auto", "trade_exchange": ex, "bybit_demo": 1 if demo else 0}
    for e2, (kk, ss, pp) in k.items():
        u[f"{e2}_api_key"] = kk
        u[f"{e2}_api_secret"] = ss
        if e2 == "okx":
            u["okx_passphrase"] = pp
    u.update(user or {})
    calls = []
    rows = list(trades or [])
    for i, s in enumerate(signals):
        tid = s.get("trade_id") or f"W{uid}-{i}"
        strat = s.get("strategy", "LEVELS")
        kw = {"user_id": uid, "symbol": s["symbol"], "direction": s["direction"], "entry": s["entry"], "sl": s["sl"],
              "tp1": s["tp1"], "tp2": s.get("tp2", 0.0), "tp3": s.get("tp3", 0.0), "trade_id": tid,
              "api_key": k.get(ex, ("", "", ""))[0] if s.get("key_ok", True) else "WRONGKEY00000000",
              "api_secret": k.get(ex, ("", "", ""))[1],
              "risk_pct": float(u.get("trade_risk_pct", 1.0)), "leverage": int(u.get("trade_leverage", 10) or 10),
              "auto_trade_mode": u.get("auto_trade_mode", "auto"), "max_trades": int(u.get("max_trades_limit", 5)),
              "bot": True, "strategy": strat, "exchange": ex, "bybit_demo": bool(u.get("bybit_demo")),
              "order_type": "Market" if strat == "VOLUME" else "Limit", "quality": s.get("quality", 4),
              "trend_ctx": s.get("trend_ctx", "")}
        if strat == "SMC" and "entry_low" in s:
            kw["entry_low"] = s["entry_low"]
            kw["entry_high"] = s["entry_high"]
        calls.append(kw)
        rows.append(trade_row(uid, tid, clock - 5 + i * gap, symbol=s["symbol"], direction=s["direction"], entry=s["entry"],
                              sl=s["sl"], tp1=s["tp1"], tp2=s.get("tp2", 0.0), tp3=s.get("tp3", 0.0), strategy=strat,
                              original_sl=s["sl"]))
    accounts = []
    for e2, (kk, ss, pp) in k.items():
        accounts.append({"ex": e2, "key": kk, "secret": ss, "passphrase": pp, "balance": balance if e2 == ex else 500.0,
                         "avail": avail if e2 == ex else None, "hedge": hedge if e2 == ex else None,
                         "bx_batch": bx_batch if e2 == ex else None})
    sc = {"name": name, "uid": uid, "exchange": ex, "clock": clock, "user": u, "keys": {e2: list(v) for e2, v in k.items()},
          "accounts": accounts, "instruments": build_instruments(prices), "faults": faults or [], "calls": calls,
          "trades": rows, "kv": kv or {}, "ks": ks_state or ["ACTIVE", ""], "regime": regime, "candles": candles or {},
          "state": state or {}, "symbol_ok": symbol_ok, "mutation_info": mutation_info, "send_fail": send_fail or [],
          "parallel": parallel, "gap": gap, "challenge": challenge_rec, "env": env or {}, "config": config or {},
          "moves": moves or []}
    SCENARIOS.append(sc)
    return sc


def gen_random(seed, n):
    rng = _random.Random(seed)
    exs = ["bybit", "bingx", "binance", "okx"]
    syms_main = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "XRP-USDT-SWAP", "DOGE-USDT-SWAP", "LINK-USDT-SWAP"]
    syms_edge = ["PEPE-USDT-SWAP", "SHIB-USDT-SWAP", "FLOKI-USDT-SWAP", "SATS-USDT-SWAP", "TINY-USDT-SWAP", "DLST-USDT-SWAP"]
    error_classes = ["insufficient_margin", "precision", "rate_limit", "duplicate", "position_mode", "delisted",
                     "timeout_after_accept", "timeout_before_accept", "html_502", "connect", "price_timeout", "rate_limit_balance"]
    for i in range(n):
        uid = 7000 + i
        ex = exs[i % 4]
        u = {"lang": rng.choice(["ru", "ru", "en"])}
        u["trade_risk_pct"] = rng.choice([0.5, 1.0, 1.5, 2.0, 3.0, 5.0])
        u["max_risk_pct"] = rng.choice([0.5, 1.0, 1.5, 2.0, 3.0])
        u["trade_leverage"] = rng.choice([3, 5, 10, 15, 20, 25, 50])
        u["max_trades_limit"] = rng.choice([1, 2, 3, 5, 10, 0])
        u["risk_mode"] = rng.choice(["risk", "risk", "risk", "notional", "margin"])
        u["fixed_amount"] = rng.choice([0.0, 0.0, 0.0, 0.5, 1.0, 2.5])
        u["partial_tp_enabled"] = rng.random() < 0.6
        u["partial_tp1_r"] = rng.choice([0.5, 0.75, 1.0, 1.25, 1.5])
        u["partial_tp1_pct"] = rng.choice([20.0, 30.0, 40.0, 50.0, 60.0])
        u["partial_tp2_r"] = rng.choice([1.0, 1.5, 2.0, 2.5, 3.0])
        u["partial_tp2_pct"] = rng.choice([15.0, 20.0, 25.0, 30.0, 40.0])
        u["auto_trade_mode"] = "confirm" if rng.random() < 0.15 else "auto"
        u["allow_low_notional_boost"] = rng.random() < 0.3
        u["prefer_market_entry"] = rng.random() < 0.2
        u["filters_all_off"] = rng.random() < 0.15
        u["allow_counter_trend"] = rng.random() < 0.5
        u["show_risk_preview"] = rng.random() < 0.8
        u["spread_check_enabled"] = rng.random() < 0.8
        u["spread_max_pct"] = rng.choice([0.1, 0.3, 1.0])
        if rng.random() < 0.12:
            u["sub_plan"] = rng.choice(["free", "trial", "", "elite"])
        if rng.random() < 0.1:
            u["sub_expires"] = T0 - 3 * 86400       # plan expired (the executor reads sub_plan only)
        demo = ex == "bybit" and rng.random() < 0.25
        prop = rng.random() < 0.12
        if prop:
            u.update(prop_mode=1, prop_start_balance=rng.choice([1000.0, 10000.0]), prop_base_risk=rng.choice([0.5, 1.0, 1.5]),
                     prop_max_dd=5.0, prop_daily_limit=4.0, prop_target=8.0, prop_trailing_dd=rng.random() < 0.5,
                     prop_day_start_balance=0.0, prop_peak_balance=0.0)
        corr = rng.random() < 0.12
        if corr:
            u.update(correlation_cap_enabled=1, correlation_cap_threshold=rng.choice([0.5, 0.7, 0.9]))
        if rng.random() < 0.1:
            u.update(adaptive_sizing_enabled=1, adaptive_sizing_mode=rng.choice(["all", "kelly", "vol", "dd"]))
        balance = rng.choice([8.0, 25.0, 120.0, 1000.0, 1000.0, 15000.0])
        if prop:
            balance = u["prop_start_balance"] * rng.choice([1.0, 0.97, 0.94, 1.02])
        avail = balance * rng.choice([1.0, 1.0, 0.3, 0.05]) if rng.random() < 0.4 else None
        hedge = None
        if rng.random() < 0.3:
            hedge = ex == "bybit"      # flip the default mode (Bybit hedge / others one-way)
        nsig = rng.choice([1, 1, 2, 3])
        sigs = []
        used = set()
        for j in range(nsig):
            sym = rng.choice(syms_edge if rng.random() < 0.3 else syms_main)
            if sym in used and rng.random() < 0.7:
                continue
            used.add(sym)
            direction = rng.choice(["LONG", "SHORT"])
            strategy = rng.choice(["LEVELS", "LEVELS", "SMC", "VOLUME"])
            price = COINS[sym]["price"]
            drift = rng.choice([0.0, 0.0005, -0.0005, 0.002, -0.003, 0.0001, 0.05]) * (1 if direction == "LONG" else -1)
            s = make_signal(rng, sym, direction, strategy, price=price, drift=drift,
                            rr=rng.choice([(1.0, 2.0, 3.0), (1.5, 2.5, 0.0), (0.8, 1.6, 2.4)]))
            s.update(symbol=sym, direction=direction, strategy=strategy, quality=rng.choice([0, 3, 4, 5]),
                     trend_ctx=rng.choice(["", "", "aligned", "with", "counter", "strong_counter"]))
            sigs.append(s)
        faults = []
        if rng.random() < 0.6:
            for _ in range(rng.choice([1, 1, 2])):
                cls = rng.choice(error_classes + EXTRA_CLASSES[ex])
                faults.append(fault(ex, cls, nth=rng.choice([1, 1, 2, 3])))
        # the market moves after the signal: a resting limit fills, a stop / take-profit triggers
        moves = []
        for s in sigs:
            if rng.random() < 0.4:
                native, pm = _native(ex, s["symbol"])
                target = rng.choice(["entry", "sl", "tp1", "away"])
                sgn = 1 if s["direction"] == "LONG" else -1
                px = {"entry": s["entry"] * (1 - sgn * 0.0008), "sl": s["sl"] * (1 - sgn * 0.001), "tp1": s["tp1"] * (1 + sgn * 0.001),
                      "away": s["entry"] * (1 + sgn * 0.01)}[target]
                moves.append([T0 + rng.choice([2.0, 20.0, 45.0, 90.0, 400.0]), ex, native, _clean(px * pm)])
        trades = []
        state = {}
        challenge_rec = None
        if rng.random() < 0.12:
            dl = rng.random() < 0.6
            challenge_rec = {"user_id": uid, "started_at": T0 - 5 * 86400, "deposit": 1000.0, "goal_kind": "pct",
                             "goal_value": 50.0, "deadline_ts": 0.0, "risk_pct": 1.0, "leverage": 5,
                             "max_trades_day": 0 if dl else 2, "daily_loss_pct": 2.0 if dl else 0.0, "topup_monthly": 0.0,
                             "strategies": ["LEVELS"], "mode": "auto", "status": "active", "finished_at": 0.0,
                             "topups": [], "daily_stop": {}, "notified": {}, "term": "none"}
            for t in range(3):
                trades.append(trade_row(uid, f"C{uid}-{t}", T0 - 3600 * (t + 1), symbol="ETH-USDT-SWAP", result="SL",
                                        result_rr=-1.0, order_id=f"oc{t}", state="CLOSED", strategy="LEVELS"))
        if rng.random() < 0.2:
            trades.append(trade_row(uid, f"O{uid}", T0 - 900, symbol=rng.choice(syms_main), direction=rng.choice(["LONG", "SHORT"]),
                                    order_id="X-OPEN", state="OPEN", strategy="LEVELS"))
        if rng.random() < 0.08:
            state["zb"] = [[uid, ex, T0 + 600.0]]
        regime = rng.choice(["ranging", "ranging", "trending_up", "trending_down", "volatile"])
        candles = {}
        if corr or u.get("adaptive_sizing_enabled") or rng.random() < 0.2:
            base_ms = int((T0 - 110 * 3600) * 1000)
            for j, s in enumerate(sigs):
                candles[f"{s['symbol']}|1H"] = bars_series(base_ms, 100, COINS[s["symbol"]]["price"], 0.0005, seed=uid + j)
            if corr:
                o = trade_row(uid, f"K{uid}", T0 - 1200, symbol="AVAX-USDT-SWAP",
                              direction=sigs[0]["direction"] if sigs else "LONG", order_id="X-CORR", state="OPEN")
                trades.append(o)
                if sigs:
                    src = candles.get(f"{sigs[0]['symbol']}|1H")
                    candles["AVAX-USDT-SWAP|1H"] = [[b[0], b[1] / 3, b[2] / 3, b[3] / 3, b[4] / 3, b[5]] for b in src] if src else []
        ks_state = None
        if rng.random() < 0.05:
            ks_state = [rng.choice(["HALTED_NEW", "HALTED_ALL"]), "maintenance"]
        if rng.random() < 0.08:
            state["auth_log"] = [[uid, ex, [T0 - 300.0, T0 - 120.0]]]
        sc = scenario(f"rnd{i:02d}_{ex}", uid=uid, ex=ex, user=u, signals=sigs, balance=balance, avail=avail, hedge=hedge,
                      faults=faults, trades=trades, regime=regime, candles=candles, state=state, ks_state=ks_state,
                      challenge_rec=challenge_rec, demo=demo, gap=rng.choice([0.0, 30.0, 120.0]),
                      symbol_ok=rng.random() > 0.04, parallel=nsig > 1 and rng.random() < 0.2, moves=moves)
        sc["seed"] = seed
        sc["rng_index"] = i


def gen_targeted():
    """One scenario per (exchange, failure class) on an otherwise clean LONG/SHORT trade, plus edges."""
    rng = _random.Random(SEED ^ 0x5A5A)
    classes = ["insufficient_margin", "precision", "rate_limit", "duplicate", "position_mode", "delisted",
               "timeout_after_accept", "timeout_before_accept", "html_502", "connect", "auth"]
    uid = 8000
    for ex in ("bybit", "bingx", "binance", "okx"):
        for cls in classes:
            uid += 1
            direction = "LONG" if uid % 2 else "SHORT"
            sym = "SOL-USDT-SWAP" if uid % 3 else "BTC-USDT-SWAP"
            price = COINS[sym]["price"]
            s = make_signal(rng, sym, direction, "LEVELS", price=price, drift=0.0003 * (1 if direction == "LONG" else -1),
                            sl_pct=0.012)
            s.update(symbol=sym, direction=direction, strategy="LEVELS", quality=4)
            ptp = cls in ("timeout_after_accept", "duplicate")
            scenario(f"tgt_{ex}_{cls}", uid=uid, ex=ex, user={"partial_tp_enabled": ptp, "trade_risk_pct": 1.0, "max_risk_pct": 2.0},
                     signals=[s], balance=1000.0, faults=[fault(ex, cls)], regime="ranging")
        # secondary endpoints (SL / TP / leverage / mode), on a MARKET entry so a position exists
        for cls in EXTRA_CLASSES[ex]:
            for ptp in (True, False):
                uid += 1
                direction = "SHORT" if uid % 2 else "LONG"
                sym = "ETH-USDT-SWAP"
                s = make_signal(rng, sym, direction, "VOLUME", price=COINS[sym]["price"], drift=0.0, sl_pct=0.01)
                s.update(symbol=sym, direction=direction, strategy="VOLUME", quality=4)
                scenario(f"tgt2_{ex}_{cls}_{'ptp' if ptp else 'main'}", uid=uid, ex=ex,
                         user={"partial_tp_enabled": ptp, "trade_risk_pct": 1.0, "max_risk_pct": 2.0, "trade_leverage": 20},
                         signals=[s], balance=2000.0, faults=[fault(ex, cls, nth=TARGET_NTH.get(cls, 1))], regime="ranging",
                         hedge=(True if cls == "position_mode" and ex == "bybit" else None))
        # the auth breaker: two earlier auth failures in the window, the third trips it
        uid += 1
        s = make_signal(rng, "SOL-USDT-SWAP", "LONG", "LEVELS", price=COINS["SOL-USDT-SWAP"]["price"], sl_pct=0.012)
        s.update(symbol="SOL-USDT-SWAP", direction="LONG", strategy="LEVELS", quality=4)
        scenario(f"auth_breaker_{ex}", uid=uid, ex=ex, signals=[s], faults=[fault(ex, "auth", nth="all")],
                 state={"auth_log": [[uid, ex, [T0 - 400.0, T0 - 200.0]]]})
        # the market fills the resting LIMIT after 20 s, then runs to the stop at 300 s
        uid += 1
        direction = "LONG" if ex in ("bybit", "binance") else "SHORT"
        s = make_signal(rng, "LINK-USDT-SWAP", direction, "LEVELS", price=COINS["LINK-USDT-SWAP"]["price"], drift=-0.002 if direction == "LONG" else 0.002,
                        sl_pct=0.015)
        s.update(symbol="LINK-USDT-SWAP", direction=direction, strategy="LEVELS", quality=4)
        native, pm = _native(ex, "LINK-USDT-SWAP")
        sgn = 1 if direction == "LONG" else -1
        scenario(f"limit_fill_then_stop_{ex}", uid=uid, ex=ex, user={"partial_tp_enabled": True}, signals=[s],
                 moves=[[T0 + 20.0, ex, native, _clean(s["entry"] * (1 - sgn * 0.001) * pm)],
                        [T0 + 300.0, ex, native, _clean(s["sl"] * (1 - sgn * 0.002) * pm)]])
        # a slow exchange: every answer comes just inside the client timeout, so place_trade overruns the
        # executor's wait_for (45 s / BingX 60 s) — before the entry (pre) or around its acceptance (all);
        # the bot then reconciles, retries once after 5 s, and (Bybit) the abandoned pybit thread goes on
        slow_paths, slow_delay = SLOW_PATHS[ex]
        for tag, paths in (("pre", slow_paths), ("all", slow_paths + [ENTRY_PATH[ex][1]] + SLOW_ENTRY_EXTRA.get(ex, []))):
            for ptp in (False, True):
                uid += 1
                direction = "LONG" if uid % 2 else "SHORT"
                s = make_signal(rng, "SOL-USDT-SWAP", direction, "VOLUME", price=COINS["SOL-USDT-SWAP"]["price"], sl_pct=0.012)
                s.update(symbol="SOL-USDT-SWAP", direction=direction, strategy="VOLUME", quality=4)
                scenario(f"slow_{tag}_{ex}{'_ptp' if ptp else ''}", uid=uid, ex=ex, user={"partial_tp_enabled": ptp},
                         signals=[s], faults=[{"ex": ex, "path": p, "nth": "all", "kind": "slow", "delay": slow_delay, "label": f"slow_{tag}"}
                                              for p in paths])
        # stale price (the market ran 4 % away) and SL already breached before placement
        for tag, drift in (("stale", 0.04), ("sl_breached", -0.02)):
            uid += 1
            s = make_signal(rng, "AVAX-USDT-SWAP", "LONG", "LEVELS", price=COINS["AVAX-USDT-SWAP"]["price"] / (1 + drift), sl_pct=0.012)
            s.update(symbol="AVAX-USDT-SWAP", direction="LONG", strategy="LEVELS", quality=4)
            scenario(f"{tag}_{ex}", uid=uid, ex=ex, signals=[s])
    # precision edges per exchange: tiny tick, 1000x coins, min notional, low-notional boost
    for ex in ("bybit", "bingx", "binance", "okx"):
        for sym, bal, boost in (("PEPE-USDT-SWAP", 1000.0, False), ("SHIB-USDT-SWAP", 400.0, False), ("SATS-USDT-SWAP", 2000.0, False),
                                ("TINY-USDT-SWAP", 300.0, False), ("DOGE-USDT-SWAP", 9.0, False), ("DOGE-USDT-SWAP", 9.0, True),
                                ("BTC-USDT-SWAP", 25.0, True)):
            uid += 1
            direction = "SHORT" if uid % 2 else "LONG"
            s = make_signal(rng, sym, direction, "LEVELS", price=COINS[sym]["price"], drift=0.0, sl_pct=0.01)
            s.update(symbol=sym, direction=direction, strategy="LEVELS", quality=5)
            scenario(f"edge_{ex}_{sym.split('-')[0].lower()}_{int(bal)}{'_boost' if boost else ''}", uid=uid, ex=ex,
                     user={"allow_low_notional_boost": boost, "partial_tp_enabled": True, "trade_risk_pct": 1.0, "max_risk_pct": 1.5},
                     signals=[s], balance=bal)
    # SMC split (Bybit place_trade_split; the others fall back to the midpoint)
    for ex in ("bybit", "bingx", "binance", "okx"):
        uid += 1
        s = make_signal(rng, "ETH-USDT-SWAP", "LONG", "SMC", price=COINS["ETH-USDT-SWAP"]["price"], drift=0.001, sl_pct=0.02)
        s.update(symbol="ETH-USDT-SWAP", direction="LONG", strategy="SMC", quality=4)
        scenario(f"smc_split_{ex}", uid=uid, ex=ex, user={"partial_tp_enabled": False}, signals=[s], balance=5000.0)
    # confirm mode, challenge daily stop, prop pilot, correlation cap, killswitch, plan expired per exchange
    for ex in ("bybit", "bingx", "binance", "okx"):
        uid += 1
        s = make_signal(rng, "XRP-USDT-SWAP", "SHORT", "LEVELS", price=COINS["XRP-USDT-SWAP"]["price"], sl_pct=0.015)
        s.update(symbol="XRP-USDT-SWAP", direction="SHORT", strategy="LEVELS", quality=4)
        scenario(f"confirm_{ex}", uid=uid, ex=ex, user={"auto_trade_mode": "confirm"}, signals=[s])
        uid += 1
        ch = {"user_id": uid, "started_at": T0 - 2 * 86400, "deposit": 1000.0, "goal_kind": "pct", "goal_value": 20.0,
              "deadline_ts": 0.0, "risk_pct": 1.0, "leverage": 5, "max_trades_day": 0, "daily_loss_pct": 2.0,
              "topup_monthly": 0.0, "strategies": ["LEVELS"], "mode": "auto", "status": "active", "finished_at": 0.0,
              "topups": [], "daily_stop": {}, "notified": {}, "term": "none"}
        tr = [trade_row(uid, f"C{uid}-{t}", T0 - 1800 * (t + 1), symbol="ETH-USDT-SWAP", result="SL", result_rr=-1.1,
                        order_id=f"oc{t}", state="CLOSED") for t in range(2)]
        scenario(f"challenge_stop_{ex}", uid=uid, ex=ex, signals=[s], trades=tr, challenge_rec=ch)
        uid += 1
        scenario(f"prop_{ex}", uid=uid, ex=ex, user={"prop_mode": 1, "prop_start_balance": 10000.0, "prop_base_risk": 1.0,
                                                     "prop_trailing_dd": True, "prop_peak_balance": 10300.0},
                 signals=[s], balance=9900.0)
        uid += 1
        base_ms = int((T0 - 110 * 3600) * 1000)
        src = bars_series(base_ms, 100, COINS["XRP-USDT-SWAP"]["price"], 0.0007, seed=uid)
        scenario(f"corr_cap_{ex}", uid=uid, ex=ex, user={"correlation_cap_enabled": 1, "correlation_cap_threshold": 0.7},
                 signals=[s], trades=[trade_row(uid, f"K{uid}", T0 - 1200, symbol="LINK-USDT-SWAP", direction="SHORT",
                                                order_id="X-CORR", state="OPEN")],
                 candles={"XRP-USDT-SWAP|1H": src, "LINK-USDT-SWAP|1H": [[b[0], b[1] * 6, b[2] * 6, b[3] * 6, b[4] * 6, b[5]] for b in src]})
        uid += 1
        scenario(f"killswitch_{ex}", uid=uid, ex=ex, signals=[s], ks_state=["HALTED_NEW", "ops halt"])
        uid += 1
        scenario(f"plan_expired_{ex}", uid=uid, ex=ex, user={"sub_plan": "free", "sub_expires": T0 - 86400}, signals=[s])
        uid += 1
        scenario(f"filters_off_{ex}", uid=uid, ex=ex, user={"filters_all_off": 1, "partial_tp_enabled": True}, signals=[s],
                 regime="trending_up")
    # Bybit specials: demo host, hedge account, rate limit on balance, two signals same symbol
    uid += 1
    s = make_signal(rng, "BTC-USDT-SWAP", "LONG", "LEVELS", price=COINS["BTC-USDT-SWAP"]["price"], drift=0.0002, sl_pct=0.006)
    s.update(symbol="BTC-USDT-SWAP", direction="LONG", strategy="LEVELS", quality=4)
    scenario("bybit_demo_hedge", uid=uid, ex="bybit", demo=True, hedge=True, user={"partial_tp_enabled": True}, signals=[s])
    uid += 1
    s2 = dict(s, trade_id=None)
    scenario("bybit_two_same_symbol", uid=uid, ex="bybit", user={"partial_tp_enabled": True}, signals=[s, s2], gap=30.0)
    for ex in ("bybit", "bingx", "binance", "okx"):
        uid += 1
        sv = make_signal(rng, "SOL-USDT-SWAP", "SHORT", "VOLUME", price=COINS["SOL-USDT-SWAP"]["price"], drift=0.0, sl_pct=0.01)
        sv.update(symbol="SOL-USDT-SWAP", direction="SHORT", strategy="VOLUME", quality=3)
        scenario(f"volume_market_ptp_{ex}", uid=uid, ex=ex, user={"partial_tp_enabled": True, "partial_tp1_pct": 60.0,
                                                                   "partial_tp2_pct": 40.0, "partial_tp1_r": 0.75}, signals=[sv])
        uid += 1
        scenario(f"rate_limit_balance_{ex}", uid=uid, ex=ex, user={"fixed_amount": 1.0}, signals=[sv],
                 faults=[fault(ex, "rate_limit_balance")])
    # BingX atomic batchOrders answered (the production 100001 is the default everywhere else):
    # processed (data.orders / data list, ± partial TP), the SL item without an orderId, endpoint gone
    for mode, ptp, direction in (("ok", False, "LONG"), ("ok", True, "SHORT"), ("list", False, "SHORT"), ("partial", False, "LONG"),
                                 ("partial", True, "SHORT"), ("missing", False, "LONG")):
        uid += 1
        sym = "ETH-USDT-SWAP"
        sb = make_signal(rng, sym, direction, "VOLUME", price=COINS[sym]["price"], drift=0.0, sl_pct=0.01)
        sb.update(symbol=sym, direction=direction, strategy="VOLUME", quality=4)
        scenario(f"bx_batch_{mode}{'_ptp' if ptp else ''}_bingx", uid=uid, ex="bingx", bx_batch=mode,
                 user={"partial_tp_enabled": ptp, "trade_risk_pct": 1.0, "max_risk_pct": 2.0}, signals=[sb], balance=2000.0)
    # [OKX-TIMEOUT-UNKNOWN] the entry answer is lost after OKX accepted it and the positions do not read:
    # the entry is asked by clOrdId — unreadable too → kept for reconcile (no cancel, no SKIP); readable
    # on the timeout reconcile → attached; absent → SKIP without a cancel
    pos_err = {"ex": "okx", "method": "GET", "path": "/api/v5/account/positions", "nth": "all", "kind": "resp",
               "json": {"code": "50011", "msg": "Too Many Requests", "data": []}, "label": "positions_unreadable"}
    for tag, q_nth, accept in (("unknown", "all", True), ("found", [1, 2, 3], True), ("absent", [1, 2, 3], False)):
        uid += 1
        direction = "LONG" if tag != "found" else "SHORT"
        s = make_signal(rng, "SOL-USDT-SWAP", direction, "LEVELS", price=COINS["SOL-USDT-SWAP"]["price"],
                        drift=0.0003 * (1 if direction == "LONG" else -1), sl_pct=0.012)
        s.update(symbol="SOL-USDT-SWAP", direction=direction, strategy="LEVELS", quality=4)
        scenario(f"okx_timeout_positions_unreadable_{tag}", uid=uid, ex="okx",
                 user={"partial_tp_enabled": tag == "found", "trade_risk_pct": 1.0, "max_risk_pct": 2.0},
                 signals=[s], balance=1000.0, regime="ranging",
                 faults=[dict(fault("okx", "timeout_after_accept" if accept else "timeout_before_accept"), method="POST"),
                         {"ex": "okx", "method": "GET", "path": "/api/v5/trade/order", "nth": q_nth, "kind": "connect",
                          "label": "order_query_down"},
                         pos_err])


    # [PTP-TP-PLACED 2026-10] OKX opened without an SL (attachAlgoOrds refused → legacy entry, the separate SL
    # refused 3×, the safety-close position read down) and the partial ladder placed → tp_placed stays 0;
    # with the SL on (only the attach refused) the ladder marks tp_placed=1
    for tag, sl_fail in (("no_sl", True), ("sl_ok", False)):
        uid += 1
        s = make_signal(rng, "SOL-USDT-SWAP", "LONG", "LEVELS", price=COINS["SOL-USDT-SWAP"]["price"], drift=0.0003, sl_pct=0.012)
        s.update(symbol="SOL-USDT-SWAP", direction="LONG", strategy="LEVELS", quality=4)
        fl = [fault("okx", "attach_algo")]
        if sl_fail:
            fl += [fault("okx", "algo_reject", nth=[1, 2, 3]),
                   {"ex": "okx", "method": "GET", "path": "/api/v5/account/positions", "nth": 1, "kind": "connect",
                    "label": "safety_close_read_down"}]
        scenario(f"okx_ptp_open_{tag}", uid=uid, ex="okx",
                 user={"partial_tp_enabled": True, "trade_risk_pct": 1.0, "max_risk_pct": 2.0},
                 signals=[s], balance=1000.0, regime="ranging", faults=fl)


# ══════════════════════════ runner ══════════════════════════
USER_COLS: list = []
CFG_KEYS = ("SMC_HOUR_FILTER_ENABLED", "SMC_HOUR_FILTER_MODE", "BAD_HOURS_UTC", "DAILY_MAX_LOSS_R")
CFG_ORIG = {k: copy.deepcopy(getattr(Config, k)) for k in CFG_KEYS}


def db_conn():
    c = sqlite3.connect(DBP, timeout=30)
    c.row_factory = sqlite3.Row
    return c


def reset_module_state():
    for d in (auto_trade._trade_locks, auto_trade._idempotency_registry, auto_trade._zero_balance_until,
              auto_trade._commodity_blocklist, auto_trade._auth_fail_log, auto_trade._auth_fail_notified,
              auto_trade._disabled_days_notified, auto_trade._LOW_NOTIONAL_NOTIFY_TS, auto_trade._SKIP_NOTIFY_DEDUP,
              skip_notify._user_unfilled, skip_notify._last_notified, tilt_detector._NOTIFY_DEDUP,
              correlation_cap._CORR_CACHE, balance_cache._BALANCE_CACHE):
        d.clear()
    if hasattr(auto_trade.execute_auto_trade, "_cb_warned"):
        delattr(auto_trade.execute_auto_trade, "_cb_warned")
    ks._cache = None
    market_regime._cached_regime = None
    market_regime._cached_at = 0.0
    UUIDS.n = 0
    PARENT.clear()
    for d in (by._per_key_buckets, by._async_per_key_buckets, by._per_key_locks, by._delisted_symbols,
              by._instrument_filter_cache, by._hedge_mode_cache, by._hedge_mode_cache_ts, by._symbol_fail_count,
              by._pybit_sessions, by._account_type_cache,
              bx._instrument_filter_cache, bn._instrument_filter_cache, ok._instrument_cache):
        d.clear()
    by._bybit_time_offset_ms = 0
    by._bybit_time_synced_at = 0.0
    by._bybit_time_last_warn_at = 0.0
    bx._bingx_time_offset_ms = 0
    bx._bingx_time_synced_at = 0.0
    bx._rate_penalty_until = 0.0
    bx._rate_sleep_s = 0.0
    bn._binance_time_offset_ms = 0
    bn.BASE_URL = "https://fapi.binance.com"
    bn._active_base_url = bn._BINANCE_FALLBACK_URLS[0]
    bn._binance_time_synced_at = 0.0
    bn._sync_warn_at = 0.0
    ok._okx_time_offset_ms = 0
    exchange_breaker.breaker._states.clear()
    fetcher_bingx._LIVE = set()
    by._api_bucket = by._TokenBucket(rate=10.0, burst=15)
    by._async_api_bucket = by._AsyncTokenBucket(rate=10.0, burst=15)


def build_user_row(over):
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
    for t in ("users", "trades", "kv", "trade_events", "bybit_account_mode"):
        con.execute(f"DELETE FROM {t}")
    state, reason = c.get("ks") or ["ACTIVE", ""]
    con.execute("UPDATE operational_state SET state=?, reason=? WHERE id=1", (state, reason))
    row = build_user_row(c["user"])
    c["user_row"] = row
    cols = list(row.keys())
    con.execute(f"INSERT INTO users ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})", [row[k] for k in cols])
    for tr in c["trades"]:
        cols = list(tr.keys())
        con.execute(f"INSERT INTO trades ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})", [tr[k] for k in cols])
    kv = dict(c.get("kv") or {})
    if c.get("challenge"):
        kv[f"challenge_{c['uid']}"] = json.dumps(c["challenge"], ensure_ascii=False)
    c["kv"] = kv
    for k, v in kv.items():
        con.execute("INSERT INTO kv (key, value) VALUES (?, ?)", (k, v))
    con.commit()
    con.close()
    st = c.get("state") or {}
    for uid, ex, until in st.get("zb", []):
        auto_trade._zero_balance_until[(uid, ex)] = until
    for uid, ex, tss in st.get("auth_log", []):
        auto_trade._auth_fail_log[(uid, ex)] = list(tss)
    for uid, sym, until in st.get("commodity", []):
        auto_trade._commodity_blocklist[(uid, sym)] = until
    if c.get("regime") is not None:
        market_regime._cached_regime = c["regime"]
        market_regime._cached_at = c["clock"] - 60.0


def dump_db():
    con = db_conn()
    trades = [dict(r) for r in con.execute(
        "SELECT trade_id, result, result_rr, state, state_changed_at, placement_attempts, order_id, pos_idx, "
        "qty, tp_placed, skip_reason, ai_filter_json, be_set FROM trades ORDER BY trade_id")]
    users = [dict(r) for r in con.execute(
        "SELECT user_id, auto_trade, prop_peak_balance, prop_last_trade_day, prop_trading_days, "
        "prop_day_start_balance FROM users ORDER BY user_id")]
    kv = {r["key"]: r["value"] for r in con.execute("SELECT key, value FROM kv ORDER BY key")}
    events = [[r["trade_id"], r["event_type"], r["payload_json"]]
              for r in con.execute("SELECT trade_id, event_type, payload_json FROM trade_events ORDER BY id")]
    hedge = {r["api_key_hash"]: bool(r["is_hedge"]) for r in con.execute("SELECT api_key_hash, is_hedge FROM bybit_account_mode")}
    con.close()
    return {"trades": trades, "users": users, "kv": kv, "events": events, "hedge": hedge}


async def run_case(c):
    reset_module_state()
    CASE.clear()
    CASE.update(c)
    for k in CFG_KEYS:
        setattr(Config, k, copy.deepcopy(CFG_ORIG[k]))
    for k, v in (c.get("config") or {}).items():
        setattr(Config, k, copy.deepcopy(v))
    env_saved = {k: os.environ.get(k) for k in (c.get("env") or {})}
    os.environ.update(c.get("env") or {})
    CLK.wall = float(c["clock"])
    sim = FX.Sim(now=lambda: CLK.wall, instruments=copy.deepcopy(c["instruments"]), faults=copy.deepcopy(c["faults"]),
                 moves=copy.deepcopy(c.get("moves") or []))
    for a in c["accounts"]:
        sim.add_account(a["ex"], a["key"], a["secret"], passphrase=a["passphrase"], balance=a["balance"], hedge=a["hedge"],
                        avail=a["avail"], bx_batch=a.get("bx_batch"))
    SIM[0] = sim
    seed(c)
    before = set(asyncio.all_tasks())
    RECS.clear()
    CAPTURE[0] = True
    results = [None] * len(c["calls"])

    async def one(i, kw, stagger=0.0):
        kw2 = dict(kw)
        kw2["bot"] = BOT_OBJ if kw.get("bot", True) else None
        if stagger:
            # parallel signals arrive 1 ms apart: the lock-arrival order is then the call order (the
            # bot's aiosqlite thread timing would otherwise decide it) — the JS run staggers the same way
            await asyncio.sleep(stagger)
        try:
            results[i] = {"ok": jsonable(await auto_trade.execute_auto_trade(**kw2))}
        except Exception as e:  # noqa: BLE001
            results[i] = {"raised": [type(e).__name__, str(e)]}

    loop = asyncio.get_running_loop()
    if c.get("parallel"):
        ts = [loop.create_task(one(i, kw, i * 0.001), name=f"call{i}") for i, kw in enumerate(c["calls"])]
        await asyncio.gather(*ts)
    else:
        for i, kw in enumerate(c["calls"]):
            if i and c.get("gap"):
                await asyncio.sleep(c["gap"])
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
    # executor threads still running after the last task (a wait_for abandoned pybit call)
    await wait_threads_idle()
    CAPTURE[0] = False
    SIM[0] = None
    for k, v in env_saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    out = {"results": results, "recs": copy.deepcopy(RECS), "clock_end": CLK.wall, "sim": jsonable(sim.snapshot()),
           "lenient": sim.lenient, "sim_errors": sim.errors}
    out.update(dump_db())
    return out


async def main():
    await database.init_db(DBP)
    con = db_conn()
    USER_COLS.extend(r[1] for r in con.execute("PRAGMA table_info(users)"))
    con.close()
    if os.environ.get("WIRE_MODE") == "routes":
        import wire_routes
        out = OUT if len(sys.argv) > 1 else os.path.join(HERE, "..", "fixtures", "wire_routes.json.gz")
        only = [x for x in os.environ.get("WIRE_ONLY", "").split(",") if x]
        per_ex = int(os.environ.get("WIRE_SESSIONS", "16"))
        vectors = await wire_routes.main(out, SEED + 1, per_ex, only)
        payload = {"meta": {"seed": SEED + 1, "sessions_per_exchange": per_ex, "python": sys.version.split()[0],
                            "d15_path": wire_routes.D15_PATH, "trade_cols": wire_routes.TRADE_COLS},
                   "vectors": vectors}
        with gzip.open(out, "wt", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        print(f"wrote {len(vectors)} route sessions → {out}", file=sys.stderr)
        return
    gen_targeted()
    gen_random(SEED, N_USERS)
    only = [x for x in os.environ.get("WIRE_ONLY", "").split(",") if x]
    vectors = []
    for c in SCENARIOS:
        if only and c["name"] not in only:
            continue
        _t0 = _REAL_TIME()
        LOOP[0] = asyncio.get_running_loop()
        exp = await run_case(c)
        vectors.append({"case": c, "expected": exp})
        nreq = sum(1 for r in exp["recs"] if r[1] == "req")
        print(f"{c['name']}: {_REAL_TIME() - _t0:.2f}s results={json.dumps(exp['results'], ensure_ascii=False)[:160]} "
              f"reqs={nreq} recs={len(exp['recs'])}", file=sys.stderr)
    payload = {"meta": {"seed": SEED, "users": N_USERS, "python": sys.version.split()[0]}, "user_cols": USER_COLS,
               "vectors": vectors}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with gzip.open(OUT, "wt", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f"wrote {len(vectors)} vectors → {OUT}", file=sys.stderr)


loop = VLoop()
LOOP[0] = loop
asyncio.set_event_loop(loop)
_rc = 0
try:
    loop.run_until_complete(main())
except BaseException:  # noqa: BLE001
    import traceback
    traceback.print_exc()
    _rc = 1
finally:
    shutil.rmtree(TMP, ignore_errors=True)
sys.stderr.flush()
sys.stdout.flush()
os._exit(_rc)
