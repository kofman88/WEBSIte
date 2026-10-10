"""m15_harness.py — the Python side of the M15 trade-ops loop vectors (PLAN_M15 §3).

The drivers of U1-U10 (gen_m15_units.py, drive_reconcile.py, drive_sl_verifier.py, drive_be_p1.py, …)
import this module FIRST — before any bot module — and get:

  * a sandbox: DB_PATH / BOT_LOG_FILE in a fresh temp dir, the test Fernet key, BOT_TOKEN_CHM / ADMIN_IDS,
    the scenario env scrubbed (RECONCILE_V2_MODE, PANIC_CLOSE_STREAK, POST_CLOSE_COOLDOWN_SEC,
    FUNDING_VELOCITY_*, ORPHAN_SWEEP_*, proxies, Sentry), cwd = the bot checkout, user_logger's file
    handler never created (USER_ACTIONS records its lines), and a guard that the checkout is left exactly
    as found (`git status --porcelain --ignored` + size / mtime of the ignored files, before = after;
    signal_registry.json removed when this run created it);
  * one virtual clock (CLK): time.time / time.monotonic / time.sleep (and FakeDT / swap_dt for
    datetime.utcnow) — wall starts at 1767225600.0 (2026-01-01 UTC), mono at 1000.0;
  * VLoop: the virtual-time event loop of tests/autotrade/wire/py/drive_wire_diff.py — the clock jumps
    EXACTLY to the next timer, and only when no coroutine, no executor thread and no aiosqlite
    operation is runnable (a DB await takes zero virtual time, so a wait_for deadline can only land in
    a trader call, a sleep or a scripted latency); timers due at the same instant fire in scheduling
    order (FIFO), like the JS vclock's `seq` tie-break and like the bot on a real clock (CPython's heap
    alone does not keep ties FIFO); task_name() attributes work to its logical task;
  * Fakes: signature-binding trader fakes at the trader-module boundary. Every call binds
    `inspect.signature(real)` first — a call the real function would refuse raises the REAL
    TypeError text (the real function is called with the same arguments to get it; recorded in
    `bind_errors`) — then is recorded {i, t, mono, task, ex, fn, bound (parameter order, defaults
    applied, test secrets replaced by labels), answer} and answered from the script of (ex, fn):
        {"value": v}                         return v (a deep copy)
        {"value": v, "err_out": [text, …]}   strict reads: append the texts to the caller's err_out
        {"raise": {"type": T, "msg": m}}     raise T(m)  (T in EXC_TYPES)
        {"latency": s, "value": v}           asyncio.sleep(s), then v
        {"hang": s}                          asyncio.sleep(s) then TimeoutError (s = None: forever)
    the last answer repeats; a call without a script is a harness error (raised and listed in
    `errors`). `sigs[ex][fn] = {sig, async}` exports every faked signature for the JS twin (harness.js
    binds the site's positional call to it — the bot→site positional map);
  * recorders: RecBot (bot.send_message, scriptable to raise), safe_send (telegram_safe
    .safe_send_message and every module-local import of it, signature-bound, scriptable result),
    a log capture (level, logger, formatted text, task, wall time; noisy third-party loggers dropped,
    the temp dir replaced by "<tmp>"), simple call recorders (metrics.record, user_logger.log_action,
    smart_prompts.trigger_after_win, trade_autopsy.stream_analyze_closed_trade → True — D23);
  * DB helpers: init_db, seed_users (UserSettings → db_upsert_user, keys encrypted; raw column
    overrides by SQL), seed_trades (INSERT, given columns only), seed_kv, dump_db (trades subset,
    kv, trade_events, trade_feedback in insertion order);
  * write_fixture: gzip JSON (mtime 0, ensure_ascii, Python float repr kept via
    tests/exchanges/py/harness.py `_jsonable`) — byte-identical output for the same inputs.

Run (from the bot checkout, production interpreter):
  cd /home/user/MAIN_BOT/CHM_BREAKER_V4
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> -I -B <site>/backend/tests/autotrade/m15/py/<driver>.py [OUT]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

# stdlib modules that must keep the REAL clock (imported before the patch below)
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
import queue  # noqa: F401  (keeps the real monotonic for its timeouts)
import re
import selectors
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import types

import datetime as _dt
import time as _time

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
BOT_REPO = "/home/user/MAIN_BOT"
HERE = os.path.dirname(os.path.abspath(__file__))
SITE_BACKEND = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
EXPY = os.path.join(SITE_BACKEND, "tests", "exchanges", "py")
FIXTURES = os.path.normpath(os.path.join(HERE, "..", "fixtures"))

WALL0 = 1767225600.0          # 2026-01-01 00:00:00 UTC (ANM-Q22)
MONO0 = 1000.0
FERNET_TEST_KEY = "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="   # test-only Fernet key (32 × "0")
MAIN_THREAD = threading.current_thread()

# ── sandbox ──────────────────────────────────────────────────────────────────
SCRUB_ENV = (
    "RECONCILE_V2_MODE", "PANIC_CLOSE_STREAK", "POST_CLOSE_COOLDOWN_SEC", "ORPHAN_SWEEP_ENABLED",
    "ORPHAN_SWEEP_INTERVAL_S", "ORPHAN_SWEEP_MIN_ORDER_AGE_S", "ORPHAN_SWEEP_RECENT_OPEN_S",
    "FUNDING_VELOCITY_MODE", "FUNDING_VELOCITY_THRESHOLD", "FUNDING_VELOCITY_WINDOW_S",
    "SENTRY_DSN", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "GROQ_API_KEY",
    "NOTIFICATION_QUEUE_ENABLED", "LOG_LEVEL",
)
TMP = tempfile.mkdtemp(prefix="m15_")
DBP = os.path.join(TMP, "bot.db")
os.environ["DB_PATH"] = DBP
os.environ["BOT_LOG_FILE"] = os.path.join(TMP, "bot.log")   # `import bot` opens it (bot.py:191)
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ["ADMIN_IDS"] = "123"
os.environ["BYBIT_FERNET_KEY"] = FERNET_TEST_KEY
os.environ["NEWS_PROVIDER"] = "none"
for _k in SCRUB_ENV:
    os.environ.pop(_k, None)
for _k in list(os.environ):
    if _k.startswith("FUNDING_VELOCITY_") or _k.startswith("ORPHAN_SWEEP_"):
        os.environ.pop(_k, None)
sys.dont_write_bytecode = True
os.chdir(BOT)
if BOT not in sys.path:
    sys.path.insert(0, BOT)


def set_env(**kw):
    """Scenario env (call before importing / reloading the module that reads it). None removes."""
    for k, v in kw.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = str(v)


def _git_state():
    """`git status --porcelain --ignored` plus (size, mtime) of every ignored FILE it lists — a log line
    appended to an ignored chm_mid.log / bot_user_actions.log / *.db would not show in the listing."""
    try:
        out = subprocess.run(["git", "-C", BOT_REPO, "status", "--porcelain", "--ignored"],
                             capture_output=True, text=True, timeout=60).stdout
    except Exception as e:  # noqa: BLE001
        return f"<git status failed: {e}>"
    lines = []
    for ln in out.splitlines():
        lines.append(ln)
        if ln.startswith("!! ") and not ln.endswith("/"):
            fp = os.path.join(BOT_REPO, ln[3:])
            try:
                st = os.stat(fp)
                lines.append(f"   {st.st_size} {st.st_mtime_ns}")
            except OSError:
                pass
    return "\n".join(lines)


class _UserActionSink(logging.Handler):
    """user_logger's dedicated logger gets this handler BEFORE user_logger is imported, so its
    `if not _logger.handlers` block never opens bot_user_actions.log in the bot checkout (D23: the site
    has no user_logger); the lines are kept here for the drivers."""

    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines: list = []

    def emit(self, record):
        try:
            self.lines.append(record.getMessage())
        except Exception as e:  # noqa: BLE001
            self.lines.append(f"<format error: {e}>")


USER_ACTIONS = _UserActionSink()
logging.getLogger("CHM.UserAction").addHandler(USER_ACTIONS)

_REGISTRY_FILE = os.path.join(BOT, "signal_registry.json")
_REGISTRY_EXISTED = os.path.exists(_REGISTRY_FILE)
_GIT_BEFORE = _git_state()


def finish():
    """Leave the bot checkout as found: drop this run's signal_registry.json, then assert git state."""
    if not _REGISTRY_EXISTED:
        try:
            os.remove(_REGISTRY_FILE)
        except FileNotFoundError:
            pass
    after = _git_state()
    if after != _GIT_BEFORE:
        before_set = set(_GIT_BEFORE.splitlines())
        diff = [ln for ln in after.splitlines() if ln not in before_set]
        raise SystemExit(f"m15_harness: the bot checkout changed during the run: {diff[:20]}")
    shutil.rmtree(TMP, ignore_errors=True)


# ── virtual clock ────────────────────────────────────────────────────────────
class VClock:
    def __init__(self):
        self.wall = WALL0
        self.mono = MONO0

    def advance(self, dt):
        if dt > 0:
            self.wall += dt
            self.mono += dt

    def set_wall(self, wall):
        """Pin the wall clock between steps (mono keeps running forward)."""
        self.wall = float(wall)


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
    """Run a coroutine with sys.modules['datetime'] = DTMOD around each of its steps (a function-local
    `import datetime` — db_set_trade_result's session_hour — then reads the virtual clock)."""

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
    wrapped.__wrapped_m15__ = fn
    return wrapped


def patch_module_datetime(mod):
    """A module that did `import datetime` / `from datetime import datetime, date` at import time."""
    if getattr(mod, "datetime", None) is _dt:
        mod.datetime = DTMOD
    elif getattr(mod, "datetime", None) is _dt.datetime:
        mod.datetime = FakeDT
    if getattr(mod, "date", None) is _dt.date:
        mod.date = FakeDate


# ── virtual-time event loop (thread and aiosqlite aware) ────────────────────
_IF_LOCK = threading.Lock()
INFLIGHT = [0]
LIVE_THREADS = [0]
PENDING_IO: dict = {}
PARENT: dict = {}
LOOP: list = [None]
THREAD_TASK = threading.local()


def inflight(d):
    with _IF_LOCK:
        INFLIGHT[0] += d


def _track(fut, what):
    inflight(+1)
    PENDING_IO[id(fut)] = what

    def _done(_f):
        inflight(-1)
        PENDING_IO.pop(id(fut), None)
    fut.add_done_callback(_done)


def vsleep(s):
    """time.sleep on the virtual clock (main thread: the clock jumps; executor thread: a loop timer)."""
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
                continue
            ev = super().select(0)
            if ev:
                return ev
            lp = LOOP[0]
            sched = getattr(lp, "_scheduled", None)
            if timeout is not None and sched:
                when = sched[0].when()
                if when > CLK.mono:      # jump EXACTLY to the next timer (the JS vclock does the same;
                    # timers due at the same instant then fire in scheduling order on both clocks: _FifoTimerHandle)
                    CLK.wall += when - CLK.mono
                    CLK.mono = when
                return []
            if timeout is None:
                for t in (asyncio.all_tasks(lp) if lp else []):
                    print(f"[deadlock] task {t.get_name()}:", file=sys.stderr)
                    t.print_stack(limit=8, file=sys.stderr)
                raise RuntimeError("virtual loop: idle with no timers (deadlock)")
            CLK.advance(timeout)
            return []


_TIMER_SEQ = itertools.count()


class _FifoTimerHandle(asyncio.TimerHandle):
    """A TimerHandle that breaks an equal-`when` tie by scheduling order — the JS vclock's `seq`, and what a
    real clock gives the bot (two timers practically never share an instant there). CPython's TimerHandle
    compares `_when` only and heapq does not keep ties FIFO (8 sleeps of one instant woke 1,3,7,6,8,5,2,4)."""

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
        """CPython 3.11 BaseEventLoop.call_at with a _FifoTimerHandle (call_later, asyncio.sleep, wait_for and
        vsleep's executor-thread timers all come through here)."""
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
            try:
                self.call_soon_threadsafe(_dec)
            except RuntimeError:
                _dec()
        cf.add_done_callback(_thread_done)
        return fut


def _install_aiosqlite_tracker():
    import aiosqlite.core
    if getattr(aiosqlite.core.Connection, "_m15_tracked", False):
        return
    orig = aiosqlite.core.Connection.__init__

    def _conn_init(self, *a, **k):
        orig(self, *a, **k)
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
    aiosqlite.core.Connection._m15_tracked = True


_install_aiosqlite_tracker()
_DEFAULT_TASK = re.compile(r"^Task-\d+$")


def task_name():
    """The logical task: the nearest named asyncio task (parents followed), 'main' outside the loop."""
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
    return "main"


def run(coro_fn, *a, **k):
    """Run `await coro_fn(*a, **k)` on a fresh VLoop (the loop is closed afterwards)."""
    loop = VLoop()
    LOOP[0] = loop
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro_fn(*a, **k))
    finally:
        try:
            loop.run_until_complete(loop.shutdown_asyncgens())
        except Exception:  # noqa: BLE001
            pass


# ── JSON ─────────────────────────────────────────────────────────────────────
if EXPY not in sys.path:
    sys.path.insert(1, EXPY)


_ADDRESS = re.compile(r" at 0x[0-9a-fA-F]+")


def jsonable(o):
    """tests/exchanges/py/harness.py `_jsonable` (NaN / ±inf tagged, tuples → lists, float repr kept) plus
    dataclasses, enums, sets (sorted repr order is the caller's business) and unknown objects as repr.
    Nothing that carries a memory address reaches a fixture (two runs must write the same bytes, and the JS
    twin can never produce an address): the recording bot is {"__bot__": true} (SafeSend records `bot is not
    None` the same way); an object with the default repr, or a repr with " at 0x…", is {"__obj__": qualname}."""
    if isinstance(o, RecBot):
        return {"__bot__": True}
    if isinstance(o, enum.Enum):
        return jsonable(o.value)
    if dataclasses.is_dataclass(o) and not isinstance(o, type):
        return {f.name: jsonable(getattr(o, f.name)) for f in dataclasses.fields(o)}
    if isinstance(o, dict):
        return {str(k): jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [jsonable(x) for x in o]
    if isinstance(o, (set, frozenset)):
        return [jsonable(x) for x in o]
    if isinstance(o, float):
        if o != o:
            return {"__float__": "nan"}
        if math.isinf(o):
            return {"__float__": "inf" if o > 0 else "-inf"}
        return o
    if isinstance(o, (str, int, bool)) or o is None:
        return o
    if isinstance(o, bytes):
        return {"__bytes__": o.hex()}
    return repr_tag(o)


def repr_tag(o):
    """{"__repr__": repr(o)}, or {"__obj__": qualname} when the repr is the default one / carries an address."""
    if type(o).__repr__ is object.__repr__:
        return {"__obj__": type(o).__qualname__}
    r = repr(o)
    if _ADDRESS.search(r):
        return {"__obj__": type(o).__qualname__}
    return {"__repr__": r}


def write_fixture(obj, path):
    """gzip JSON, deterministic bytes (mtime 0, no file name in the header, ensure_ascii)."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    from harness import _jsonable   # tests/exchanges/py/harness.py — the encoding every replay suite reads
    data = json.dumps(_jsonable(jsonable(obj)), ensure_ascii=True, allow_nan=True).encode("ascii")
    with open(path, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as fh:   # no name in the header
            fh.write(data)
    return len(data)


# ── logs ─────────────────────────────────────────────────────────────────────
NOISY_LOGGERS = ("asyncio", "aiosqlite", "urllib3", "pybit", "httpx", "httpcore", "openai", "aiohttp", "charset_normalizer",
                 "matplotlib", "PIL", "numexpr", "groq", "hpack", "websockets", "aiogram")


class LogCapture(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines: list = []
        self.min_level = logging.DEBUG

    def emit(self, record):
        name = record.name
        if any(name == d or name.startswith(d + ".") for d in NOISY_LOGGERS):
            return
        if record.levelno < self.min_level:
            return
        try:
            msg = record.getMessage()
        except Exception as e:  # noqa: BLE001
            msg = f"<log format error: {e}>"
        exc = None
        if record.exc_info and record.exc_info[1] is not None:
            exc = f"{type(record.exc_info[1]).__name__}: {record.exc_info[1]}"
        self.lines.append({"t": CLK.wall, "task": task_name(), "level": record.levelname, "logger": name,
                           "msg": msg.replace(TMP, "<tmp>"), "exc": exc})

    def take(self):
        out, self.lines = self.lines, []
        return out


LOGS = LogCapture()
_root = logging.getLogger()
_root.addHandler(LOGS)
_root.setLevel(logging.DEBUG)


# ── trader fakes ─────────────────────────────────────────────────────────────
EXC_TYPES = {
    "Exception": Exception, "RuntimeError": RuntimeError, "ValueError": ValueError, "TypeError": TypeError,
    "ConnectionError": ConnectionError, "OSError": OSError, "AttributeError": AttributeError,
    "ZeroDivisionError": ZeroDivisionError, "TimeoutError": asyncio.TimeoutError,
}
SECRET_PARAMS = ("api_key", "api_secret", "secret", "passphrase", "key")
_NODEF = {"__nodefault__": True}


def mk_exc(spec):
    t = spec.get("type", "Exception")
    if t == "TimeoutError":
        return asyncio.TimeoutError(*([spec["msg"]] if spec.get("msg") else []))
    return EXC_TYPES[t](spec.get("msg", ""))


def sig_json(sig):
    return [[p.name, p.kind.name, jsonable(p.default) if p.default is not inspect.Parameter.empty else _NODEF]
            for p in sig.parameters.values()]


class HarnessError(AssertionError):
    pass


class Fakes:
    """Signature-binding fakes of trader-module functions (see the module docstring)."""

    def __init__(self):
        self.script: dict = {}
        self.calls: list = []
        self.bind_errors: list = []
        self.errors: list = []
        self.sigs: dict = {}
        self.labels: dict = {}
        self.orig: dict = {}

    # labels: test credential value → stable name in the records
    def label(self, value, name):
        if value:
            self.labels[value] = name

    def _mask(self, name, v):
        if isinstance(v, str) and v in self.labels:
            return self.labels[v]
        if name in SECRET_PARAMS and isinstance(v, str) and v:
            return "<secret>"
        return jsonable(copy.deepcopy(v)) if isinstance(v, (list, dict)) else jsonable(v)

    def set(self, ex, fn, *answers):
        self.script[(ex, fn)] = [copy.deepcopy(a) for a in answers]

    def _take(self, ex, fn):
        q = self.script.get((ex, fn))
        if not q:
            msg = f"m15 harness: no scripted answer for {ex}.{fn}"
            self.errors.append(msg)
            raise HarnessError(msg)
        return copy.deepcopy(q.pop(0) if len(q) > 1 else q[0])

    def install(self, ex, mod, fns):
        for fn in fns:
            real = getattr(mod, fn)
            self.orig[(ex, fn)] = (mod, real)
            sig = inspect.signature(real)
            is_async = inspect.iscoroutinefunction(inspect.unwrap(real))
            self.sigs.setdefault(ex, {})[fn] = {"sig": sig_json(sig), "async": is_async}
            setattr(mod, fn, self._make(ex, fn, real, sig, is_async))

    def install_all(self, fns_by_ex):
        """{ex: (module, [fn, …])}"""
        for ex, (mod, fns) in fns_by_ex.items():
            self.install(ex, mod, [f for f in fns if hasattr(mod, f)])

    def restore(self):
        """Put the real functions back (the reverse of install)."""
        for (_ex, fn), (mod, real) in self.orig.items():
            setattr(mod, fn, real)
        self.orig.clear()

    def _make(self, ex, fn, real, sig, is_async):
        harness = self

        def fake(*a, **kw):
            try:
                b = sig.bind(*a, **kw)
            except TypeError as bind_err:
                text = str(bind_err)
                inner = inspect.unwrap(real)
                try:
                    co = inner(*a, **kw)        # the real argument error (never valid here)
                except TypeError as e:
                    text = str(e)
                else:
                    if inspect.iscoroutine(co):
                        co.close()
                harness.bind_errors.append({"t": CLK.wall, "mono": CLK.mono, "task": task_name(), "ex": ex, "fn": fn,
                                            "nargs": len(a), "kwargs": sorted(kw), "error": text})
                raise TypeError(text) from None
            names = list(sig.parameters)
            raw_args = [harness._mask(names[i] if i < len(names) else "", v) for i, v in enumerate(a)]
            raw_kw = {k: harness._mask(k, v) for k, v in kw.items()}
            b.apply_defaults()
            bound = [[k, harness._mask(k, v)] for k, v in b.arguments.items()]
            ans = harness._take(ex, fn)
            harness.calls.append({"i": len(harness.calls), "t": CLK.wall, "mono": CLK.mono, "task": task_name(),
                                  "ex": ex, "fn": fn, "args": raw_args, "kwargs": raw_kw, "bound": bound,
                                  "answer": jsonable(ans)})
            if is_async:
                return harness._respond(ans, b.arguments)
            return harness._respond_sync(ans, b.arguments)
        fake.__m15_fake__ = (ex, fn)
        return fake

    @staticmethod
    def _apply(ans, args):
        if ans.get("err_out") and args.get("err_out") is not None:
            args["err_out"].extend(ans["err_out"])
        if "raise" in ans:
            raise mk_exc(ans["raise"])
        return ans.get("value")

    async def _respond(self, ans, args):
        if "latency" in ans:
            await asyncio.sleep(ans["latency"])
        if "hang" in ans:
            await asyncio.sleep(10 ** 9 if ans["hang"] is None else ans["hang"])
            raise asyncio.TimeoutError()
        return self._apply(ans, args)

    def _respond_sync(self, ans, args):
        if "latency" in ans or "hang" in ans:
            raise HarnessError("latency / hang on a synchronous function")
        return self._apply(ans, args)


# ── delivery recorders ───────────────────────────────────────────────────────
def _kb_rows(markup):
    if markup is None:
        return None
    rows = getattr(markup, "inline_keyboard", None)
    if rows is None:
        return repr_tag(markup)
    return [[[getattr(b, "text", None), getattr(b, "callback_data", None) or getattr(b, "url", None)] for b in r] for r in rows]


class RecBot:
    """A recording aiogram Bot: send_message(chat_id, text, **kw). `fail_on` substrings → raise."""

    def __init__(self, sink):
        self.sink = sink
        self.fail_on: list = []
        self._n = 0

    async def send_message(self, chat_id, text, **kw):
        kw2 = {k: (_kb_rows(v) if k == "reply_markup" else v) for k, v in kw.items()}
        self.sink.append({"via": "bot", "t": CLK.wall, "task": task_name(), "uid": chat_id, "text": text, "kw": jsonable(kw2)})
        for s in self.fail_on:
            if s in str(text):
                raise RuntimeError("Telegram send failed (scripted)")
        self._n += 1
        return types.SimpleNamespace(message_id=self._n, chat=types.SimpleNamespace(id=chat_id))


class SafeSend:
    """telegram_safe.safe_send_message recorder (bound to the real signature); result scripted by text."""

    def __init__(self, sink):
        self.sink = sink
        self.results: list = []        # [(substring, result)] first match wins; default True
        import telegram_safe
        self.sig = inspect.signature(telegram_safe.safe_send_message)
        self.real = telegram_safe.safe_send_message

    async def __call__(self, *a, **kw):
        b = self.sig.bind(*a, **kw)
        b.apply_defaults()
        args = dict(b.arguments)
        bot = args.pop("bot")
        uid = args.pop("user_id")
        text = args.pop("text")
        defaults = {p.name: p.default for p in self.sig.parameters.values() if p.default is not inspect.Parameter.empty}
        extra = {k: (_kb_rows(v) if k == "reply_markup" else v) for k, v in args.items() if v != defaults.get(k)}
        res = True
        for s, r in self.results:
            if s in str(text):
                res = r
                break
        self.sink.append({"via": "safe", "t": CLK.wall, "task": task_name(), "uid": uid, "text": text,
                          "parse_mode": args.get("parse_mode"), "kw": jsonable(extra), "bot": bot is not None,
                          "result": res if not isinstance(res, dict) else None})
        if isinstance(res, dict) and "raise" in res:
            raise mk_exc(res["raise"])
        return res

    def install(self, *modules):
        import telegram_safe
        telegram_safe.safe_send_message = self
        for m in modules:
            if hasattr(m, "safe_send_message"):
                m.safe_send_message = self


class CallRecorder:
    """A recording stand-in for a fire-and-forget collaborator: (name, args, kwargs) → `ret`. The bot object
    the bot passes first (smart_prompts.trigger_after_win(self.bot, …), trade_autopsy
    .stream_analyze_closed_trade(self.bot, …)) is recorded as {"__bot__": true} (jsonable)."""

    def __init__(self, sink, name, ret=None, is_async=True):
        self.sink, self.name, self.ret, self.is_async = sink, name, ret, is_async

    def _rec(self, a, kw):
        self.sink.append({"t": CLK.wall, "task": task_name(), "fn": self.name, "args": jsonable(list(a)), "kwargs": jsonable(kw)})
        return self.ret

    def __call__(self, *a, **kw):
        if self.is_async:
            async def _co():
                return self._rec(a, kw)
            return _co()
        return self._rec(a, kw)


# ── cancels vs semaphore hand-overs ─────────────────────────────────────────
class GuardedSemaphore(asyncio.Semaphore):
    """asyncio.Semaphore that records every release (virtual instant, releasing task) for guarded_cancel.

    A cancel that another task (a canceller's timer, the shutdown cancel) delivers at the SAME virtual
    instant as a release, after it, cannot be reproduced by the site's createSemaphore: the bot's woken
    waiter raises CancelledError at acquire and passes the slot on, the site's waiter has already resumed
    on a microtask and entered its body (its first call leaves). Vectors must not put a cancel there."""

    def __init__(self, value=1):
        super().__init__(value)
        self.releases: list = []          # [(mono, task)]

    def release(self):
        try:
            me = asyncio.current_task()
        except RuntimeError:
            me = None
        self.releases.append((CLK.mono, me))
        super().release()


def guarded_cancel(task, *sems):
    """task.cancel() for a vector: HarnessError when one of `sems` (GuardedSemaphore) was released at this
    very instant by another task — offset the cancel (e.g. +0.5 s). A cancel issued by the releasing task's
    own step (release, then cancel the woken waiter) is reproduced by the site and allowed."""
    try:
        me = asyncio.current_task()
    except RuntimeError:
        me = None
    for sem in sems:
        for at, who in getattr(sem, "releases", ()):
            if at == CLK.mono and who is not me:
                raise HarnessError(f"m15 harness: a cancel at mono {CLK.mono} lands on a semaphore release of the same "
                                   f"instant (task {who.get_name() if who is not None else None}); the site's woken "
                                   f"waiter would enter its body — offset the cancel")
    return task.cancel()


# ── DB ───────────────────────────────────────────────────────────────────────
DEFAULT_TRADE_DUMP_COLS = ("trade_id", "result", "result_rr", "closed_pnl_usd", "skip_reason", "state", "state_changed_at",
                           "tp_placed", "tp_retry_count", "trail_level", "be_set")


KV_BASELINE: dict = {}


async def init_db():
    """database.init_db on the temp DB; the kv rows init_db itself writes (migration markers) are the
    baseline dump_db leaves out (the site's engine_kv starts empty)."""
    import database
    await database.init_db(DBP)
    KV_BASELINE.clear()
    KV_BASELINE.update({r["key"]: r["value"] for r in sql_rows("SELECT key, value FROM kv")})


def sql(stmt, params=()):
    con = sqlite3.connect(DBP)
    try:
        cur = con.execute(stmt, params)
        con.commit()
        return cur.fetchall()
    finally:
        con.close()


def sql_rows(stmt, params=()):
    con = sqlite3.connect(DBP)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(stmt, params).fetchall()]
    finally:
        con.close()


async def seed_users(users, fakes=None):
    """users: [{user_id, username?, fields: {…UserSettings…}, keys: {ex: [key, secret, passphrase]}, raw: {col: value}}]

    UserSettings(user_id) + fields + keys → db_upsert_user (keys Fernet-encrypted); then `raw` columns are
    written verbatim by SQL (NULL, '' , '0', an undecryptable token …). Returns the users rows as stored
    (keys still encrypted)."""
    import database
    from user_manager import UserSettings
    for u in users:
        us = UserSettings(user_id=u["user_id"])
        if u.get("username") is not None:
            us.username = u["username"]
        for k, v in (u.get("fields") or {}).items():
            setattr(us, k, v)
        for ex, kv in (u.get("keys") or {}).items():
            key, sec = kv[0], kv[1]
            setattr(us, f"{ex}_api_key", key)
            setattr(us, f"{ex}_api_secret", sec)
            if ex == "okx":
                us.okx_passphrase = kv[2] if len(kv) > 2 else ""
            if fakes is not None:
                fakes.label(key, f"{ex}_key_{u['user_id']}")
                fakes.label(sec, f"{ex}_secret_{u['user_id']}")
                if ex == "okx" and len(kv) > 2:
                    fakes.label(kv[2], f"okx_pp_{u['user_id']}")
        await database.db_upsert_user(us.to_db())
        for col, v in (u.get("raw") or {}).items():
            sql(f"UPDATE users SET {col}=? WHERE user_id=?", (v, u["user_id"]))


def seed_trades(rows):
    """rows: [{col: value}] — INSERT with the given columns only (others keep the column default), in order."""
    con = sqlite3.connect(DBP)
    try:
        for r in rows:
            cols = list(r)
            con.execute(f"INSERT INTO trades ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", [r[c] for c in cols])
        con.commit()
    finally:
        con.close()


def seed_kv(items):
    con = sqlite3.connect(DBP)
    try:
        for k, v in items:
            con.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", (k, v))
        con.commit()
    finally:
        con.close()


def dump_db(t_ref=None, trade_cols=DEFAULT_TRADE_DUMP_COLS, trade_ids=None, kv_prefix=None):
    """The DB after a step: trades (subset, rowid order; state_changed_at − t_ref), kv (key order, without
    init_db's own rows), trade_events and trade_feedback (id order, without the id column).
    `trade_ids` limits trades / events / feedback to those ids, `kv_prefix` the kv keys."""
    where, params = "", ()
    if trade_ids is not None:
        where = f" WHERE trade_id IN ({', '.join('?' * len(trade_ids))})"
        params = tuple(trade_ids)
    tr = sql_rows(f"SELECT {', '.join(trade_cols)} FROM trades{where} ORDER BY rowid", params)
    if t_ref is not None:
        for r in tr:
            if r.get("state_changed_at") is not None:
                r["state_changed_at"] = r["state_changed_at"] - t_ref
    kv = [r for r in sql_rows("SELECT key, value FROM kv ORDER BY key") if KV_BASELINE.get(r["key"]) != r["value"]]
    if kv_prefix is not None:
        kv = [r for r in kv if r["key"].startswith(kv_prefix)]
    out = {
        "trades": tr,
        "kv": kv,
        "trade_events": sql_rows(f"SELECT trade_id, ts, event_type, payload_json FROM trade_events{where} ORDER BY id", params),
    }
    try:
        fb = sql_rows(f"SELECT * FROM trade_feedback{where} ORDER BY id", params)
    except sqlite3.OperationalError:
        fb = []
    for r in fb:
        r.pop("id", None)
    out["trade_feedback"] = fb
    return out


async def drain_bg(prefixes=("evt_",), max_iters=100000):
    """Await the fire-and-forget tasks of a step (emit_bg's `evt_*` writes) and every aiosqlite job."""
    me = asyncio.current_task()
    for _ in range(max_iters):
        pend = [t for t in asyncio.all_tasks() if t is not me and not t.done() and t.get_name().startswith(tuple(prefixes))]
        if not pend and INFLIGHT[0] == 0:
            return
        if pend:
            await asyncio.wait(pend)
        else:
            await asyncio.sleep(0)
    raise HarnessError("drain_bg: background work never settled")


def explain(stmt, params=()):
    """EXPLAIN QUERY PLAN details (the plan decides the row order of the bot's ORDER-BY-less reads)."""
    return [r[3] for r in sql(f"EXPLAIN QUERY PLAN {stmt}", params)]


# ── self-test (consumed by tests/autotrade/m15/harness.selftest.test.js) ─────
async def _selftest_body():
    import bybit_trader
    import bingx_trader
    import binance_trader
    import okx_trader
    import telegram_safe
    F = Fakes()
    F.install_all({
        "bybit": (bybit_trader, ["get_positions", "is_delisted", "get_open_orders"]),
        "bingx": (bingx_trader, ["get_positions", "get_open_orders"]),
        "binance": (binance_trader, ["get_open_orders", "cancel_all_orders"]),
        "okx": (okx_trader, ["get_positions", "get_algo_sl_orders"]),
    })
    for v, n in (("BYK-1", "by_key"), ("BYS-1", "by_secret"), ("OKK-1", "ok_key"), ("OKS-1", "ok_secret"), ("OKP-1", "ok_pp"),
                 ("BXK-1", "bx_key"), ("BXS-1", "bx_secret"), ("BNK-1", "bn_key"), ("BNS-1", "bn_secret")):
        F.label(v, n)
    F.set("bybit", "get_positions", {"value": [{"symbol": "BTCUSDT", "side": "Buy", "size": 0.5, "avgPrice": 100.25}]})
    F.set("okx", "get_positions", {"value": None, "err_out": ["code: 50001 Service temporarily unavailable"]})
    F.set("bingx", "get_positions", {"hang": 30})
    F.set("binance", "cancel_all_orders", {"latency": 2.5, "value": {"ok": True, "cancelled": 2}})
    F.set("okx", "get_algo_sl_orders", {"raise": {"type": "RuntimeError", "msg": "algo read failed"}})
    F.set("bybit", "is_delisted", {"value": False}, {"value": True})
    F.set("bingx", "get_open_orders", {"latency": 1.0, "value": [{"symbol": "BTC-USDT", "orderId": "1"}]})
    F.set("bybit", "get_open_orders", {"latency": 3.0, "value": []})
    sink: list = []
    bot = RecBot(sink)
    bot.fail_on.append("FAIL")
    ss = SafeSend(sink)
    ss.results.append(("blocked", False))
    ss.install()
    out = []
    t0 = CLK.mono
    w0 = CLK.wall
    out.append(["start", w0, t0])
    errs: list = []
    r = await bybit_trader.get_positions("BYK-1", "BYS-1", demo=True, strict=True, err_out=errs)
    out.append(["bybit.get_positions", jsonable(r), list(errs), CLK.mono - t0])
    errs2: list = []
    r = await okx_trader.get_positions("OKK-1", "OKS-1", passphrase="OKP-1", strict=True, err_out=errs2)
    out.append(["okx.get_positions", r, list(errs2), CLK.mono - t0])
    r = await okx_trader.get_positions("OKK-1", "OKS-1", "OKP-1", "")       # BE1-Q9 positional binding
    out.append(["okx.get_positions.positional", r, CLK.mono - t0])
    try:
        await asyncio.wait_for(bingx_trader.get_positions("BXK-1", "BXS-1"), timeout=6.0)
        out.append(["bingx.no_timeout"])
    except asyncio.TimeoutError:
        out.append(["bingx.timeout", CLK.mono - t0])
    try:
        await binance_trader.get_open_orders("BNK-1", "BNS-1", "BTCUSDT")   # BE1-Q12: the real TypeError
        out.append(["binance.no_type_error"])
    except TypeError as e:
        out.append(["binance.get_open_orders.TypeError", str(e)])
    r = await binance_trader.cancel_all_orders("BNK-1", "BNS-1", "BTCUSDT")
    out.append(["binance.cancel_all_orders", r, CLK.mono - t0])
    try:
        await okx_trader.get_algo_sl_orders("OKK-1", "OKS-1", "BTC-USDT-SWAP", passphrase="OKP-1")
    except RuntimeError as e:
        out.append(["okx.get_algo_sl_orders.raise", type(e).__name__, str(e)])
    out.append(["bybit.is_delisted", bybit_trader.is_delisted("BTCUSDT"), bybit_trader.is_delisted("BTCUSDT"),
                bybit_trader.is_delisted("ETHUSDT")])

    async def worker(name, coro_fn):
        r = await coro_fn()
        return [name, jsonable(r), CLK.mono - t0]
    t_a = asyncio.create_task(worker("a", lambda: bingx_trader.get_open_orders("BXK-1", "BXS-1")), name="slv_a")
    t_b = asyncio.create_task(worker("b", lambda: bybit_trader.get_open_orders("BYK-1", "BYS-1", demo=False)), name="slv_b")
    res = await asyncio.gather(t_a, t_b, return_exceptions=True)
    out.append(["gather", jsonable(res)])
    await asyncio.sleep(10)
    out.append(["after_sleep", CLK.mono - t0, CLK.wall - w0])
    ok1 = await telegram_safe.safe_send_message(bot, 201, "<b>hello</b>")
    ok2 = await telegram_safe.safe_send_message(bot, 202, "you blocked me", parse_mode=None)
    try:
        await bot.send_message(123, "admin FAIL", parse_mode="HTML")
        out.append(["bot.no_raise"])
    except RuntimeError as e:
        out.append(["bot.send_message.raise", str(e)])
    await bot.send_message(123, "admin ok", parse_mode="HTML")
    out.append(["safe_send", ok1, ok2])
    # fire-and-forget collaborators: the bot passes its Bot object first (scanner_mid.py trigger_after_win /
    # stream_analyze_closed_trade) — recorded as a tag, never as a repr with an address
    rec_sink: list = []
    r_trig = await CallRecorder(rec_sink, "smart_prompts.trigger_after_win")(bot, 201, "BTCUSDT", 1.5)
    r_aut = await CallRecorder(rec_sink, "trade_autopsy.stream_analyze_closed_trade", ret=True)(
        bot, 201, {"trade_id": "st-1", "symbol": "BTCUSDT"}, lang="ru", notify=bot)
    r_met = CallRecorder(rec_sink, "metrics.record", is_async=False)("be_monitor.pass", 1, tags={"obj": object(), "fn": lambda: 0})
    logging.getLogger("CHM.M15Selftest").info("[M15-SELFTEST] value=%s ratio=%.2f", 3, 0.125)
    try:
        raise ValueError("boom")
    except ValueError:
        logging.getLogger("CHM.M15Selftest").exception("[M15-SELFTEST] caught")
    F.restore()
    telegram_safe.safe_send_message = ss.real
    return {"out": out, "calls": F.calls, "bind_errors": F.bind_errors, "errors": F.errors, "sigs": F.sigs,
            "labels": {v: k for k, v in F.labels.items()}, "sent": sink,
            "recorded": rec_sink, "recorder_results": [r_trig, r_aut, r_met],
            "logs": [ln for ln in LOGS.take() if ln["logger"] == "CHM.M15Selftest"]}


async def _selftest_semaphores():
    """asyncio.Semaphore traces (CPython 3.11.17) for the JS createSemaphore: per-task [t, event] lists."""
    scenarios = []

    async def scenario(name, value, specs, cancels=(), guard=True, deviation=False):
        sem = GuardedSemaphore(value) if guard else asyncio.Semaphore(value)
        base = CLK.mono
        traces: dict = {}
        acq_order: list = []
        tasks: dict = {}
        active = [0]
        peak = [0]

        def ev(tid, what):
            traces.setdefault(tid, []).append([round(CLK.mono - base, 6), what])

        async def holder(tid, start, hold, cancel_other=None):
            if start:
                await asyncio.sleep(start)
            ev(tid, "want")
            try:
                async with sem:
                    acq_order.append(tid)
                    active[0] += 1
                    peak[0] = max(peak[0], active[0])
                    ev(tid, "acquired")
                    try:
                        await asyncio.sleep(hold)
                    finally:
                        active[0] -= 1
                    ev(tid, "release")
                    if cancel_other:
                        sem.release()          # hand the slot over …
                        guarded_cancel(tasks[cancel_other], sem)   # … and cancel the woken waiter in this same step
                        await sem.acquire()
            except asyncio.CancelledError:
                ev(tid, "cancelled")
                raise
            ev(tid, "done")

        for s in specs:
            tasks[s[0]] = asyncio.get_running_loop().create_task(holder(*s), name=f"sem_{s[0]}")

        async def canceller(tid, at, pre=None):
            if pre:                    # a first sleep: the cancel's timer is scheduled after the holders' own
                await asyncio.sleep(pre)
                await asyncio.sleep(at - pre)
            else:
                await asyncio.sleep(at)
            if guard:
                guarded_cancel(tasks[tid], sem)
            else:
                tasks[tid].cancel()
        cts = [asyncio.get_running_loop().create_task(canceller(*c)) for c in cancels]
        res = await asyncio.gather(*tasks.values(), *cts, return_exceptions=True)
        refused = [str(r) for r in res if isinstance(r, HarnessError)]
        scenarios.append({"name": name, "value": value, "specs": [list(s) for s in specs], "cancels": [list(c) for c in cancels],
                          "traces": traces, "acquire_order": acq_order, "peak": peak[0], "final_value": sem._value,
                          "locked": sem.locked(), "guard": guard, "deviation": deviation, "refused": refused})

    await scenario("fifo_2_of_5", 2, [("t1", 0, 10), ("t2", 0, 10), ("t3", 0, 10), ("t4", 0, 10), ("t5", 0, 10)])
    await scenario("cancel_queued", 1, [("a", 0, 10), ("b", 1, 10), ("c", 2, 10), ("d", 3, 10)], cancels=[("c", 5)])
    await scenario("woken_then_cancelled", 1, [("a", 0, 10, "b"), ("b", 1, 10), ("c", 2, 10)])
    await scenario("no_barging", 1, [("a", 0, 10), ("b", 1, 5), ("e", 10, 1)])
    await scenario("verifier_5_of_12", 5, [(f"v{i:02d}", 0, [3, 7, 1, 10, 2, 2, 8, 4, 6, 1, 9, 5][i]) for i in range(12)])
    await scenario("cancel_holder", 1, [("a", 0, 10), ("b", 1, 10), ("c", 2, 10)], cancels=[("a", 4)])
    await scenario("cancel_all_waiting", 2, [("a", 0, 30), ("b", 0, 30), ("c", 1, 5), ("d", 1, 5), ("e", 1, 5)],
                   cancels=[("c", 3), ("d", 3), ("e", 3)])
    # same-instant timers decide who gets a slot (FIFO on both clocks — _FifoTimerHandle / vclock seq)
    await scenario("tie_wake_3_of_6", 3, [("t0", 0, 2), ("t1", 4, 2), ("t2", 4, 1), ("t3", 4, 2), ("t4", 4, 4), ("t5", 3, 5)],
                   cancels=[("t2", 12), ("t4", 9.5, 0.5)])
    await scenario("tie_8_of_3", 3, [(f"w{i}", 4, 2) for i in range(1, 9)])
    # the deviation the site cannot reproduce: a canceller's timer due at the instant a's release hands the slot
    # to b (scheduled after a's) — the bot's b raises at acquire, the site's b enters its body (README)
    await scenario("same_instant_cancel", 1, [("a", 0, 10), ("b", 1, 10), ("c", 2, 10)], cancels=[("b", 10, 0.5)],
                   guard=False, deviation=True)
    # … and the harness refuses that vector
    await scenario("same_instant_cancel_guarded", 1, [("a", 0, 10), ("b", 1, 10), ("c", 2, 10)], cancels=[("b", 10, 0.5)])

    # locked() while a woken waiter has not resumed yet: two releases in one step (no barging past it)
    sem = asyncio.Semaphore(0)
    log = []

    async def waiter(name):
        await sem.acquire()
        log.append([name, "acquired", sem._value, sem.locked()])
    tb = asyncio.get_running_loop().create_task(waiter("b"))
    await asyncio.sleep(0)
    log.append(["queued", sem._value, sem.locked()])
    sem.release()
    log.append(["release1", sem._value, sem.locked()])
    sem.release()
    log.append(["release2", sem._value, sem.locked()])
    await tb
    log.append(["after", sem._value, sem.locked()])
    scenarios.append({"name": "double_release_locked", "log": log})

    # a waiter that queued behind a woken-but-not-resumed waiter is woken by that waiter's resumption
    # (`if self._value > 0: self._wake_up_next()` after a successful wait)
    sem2 = asyncio.Semaphore(0)
    log2 = []

    async def waiter2(name):
        log2.append([name, "acquire", sem2._value, sem2.locked()])
        await sem2.acquire()
        log2.append([name, "acquired", sem2._value, sem2.locked()])
    tb2 = asyncio.get_running_loop().create_task(waiter2("b"))
    await asyncio.sleep(0)
    td2 = asyncio.get_running_loop().create_task(waiter2("d"))   # its first step runs after the releases
    sem2.release()
    sem2.release()
    log2.append(["released", sem2._value, sem2.locked()])
    await asyncio.gather(tb2, td2)
    log2.append(["after", sem2._value, sem2.locked()])
    scenarios.append({"name": "post_acquire_wake", "log": log2})
    return scenarios


async def _selftest_ties():
    """Timers due at the same virtual instant fire in scheduling order (FIFO), as on the JS vclock."""
    lp = asyncio.get_running_loop()
    out = {}
    for n in (4, 8, 16):
        order: list = []

        async def sleeper(tid, order=order):
            await asyncio.sleep(4)
            order.append(tid)
        await asyncio.gather(*[lp.create_task(sleeper(f"t{i}")) for i in range(1, n + 1)])
        out[f"sleep_{n}"] = order
    order2: list = []
    delays = [3, 1, 3, 2, 1, 3, 2, 1, 2, 3]
    for i, d in enumerate(delays):          # call_later of three instants, scheduled out of instant order
        lp.call_later(d, order2.append, f"c{i}@{d}")
    await asyncio.sleep(5)
    out["call_later_delays"] = delays
    out["call_later"] = order2
    return out


async def _selftest_db():
    """Seeds + a real db_set_trade_result round (TP1 with closed PnL, SKIP with a long reason, a CAS miss on a
    closed row) + the dump — the JS twin seeds the same rows and runs tradeDb.setTradeResult."""
    import database
    if not KV_BASELINE:
        await init_db()
    F = Fakes()
    t = CLK.wall
    users = [{"user_id": 9001, "username": "st1",
              "fields": {"sub_plan": "pro", "sub_status": "active", "sub_expires": t + 86400.0, "active": True,
                         "auto_trade": True, "trade_exchange": "bybit"},
              "keys": {"bybit": ["ST-KEY-0001", "ST-SECRET-0001"]}, "raw": {"created_at": t - 10.0}}]
    await seed_users(users, F)
    base = {"user_id": 9001, "symbol": "BTCUSDT", "direction": "LONG", "entry": 100.0, "sl": 95.0, "tp1": 105.0, "tp2": 110.0,
            "tp3": 115.0, "created_at": t - 3600.0, "state": "OPEN", "strategy": "SMC", "quality": 4}
    trades = [dict(base, trade_id="st-1", order_id="OID1"),
              dict(base, trade_id="st-2", order_id="OID2", direction="SHORT", entry=0.0123, sl=0.0130, tp1=0.0110),
              dict(base, trade_id="st-3", order_id="OID3", result="TP1", result_rr=0.8, state="CLOSED")]
    users_raw = sql_rows("SELECT * FROM users WHERE user_id=9001")
    for r in users_raw:
        for c in [f"{ex}_api_{p}" for ex in ("bybit", "bingx", "binance", "okx") for p in ("key", "secret")] + ["okx_passphrase"]:
            r.pop(c, None)
    seed_trades(trades)
    seed_kv([("m15_selftest_kv", "1")])
    LOGS.take()
    set_result = swap_dt(database.db_set_trade_result)
    CLK.advance(5.0)
    rows = [await set_result("st-1", "TP1", 1.5, closed_pnl_usd=4.7),
            await set_result("st-2", "SKIP", 0.0, skip_reason="selftest_" + "x" * 80),
            await set_result("st-3", "SL", -1.0)]
    await drain_bg()
    return {"t": t, "users": users, "users_raw": users_raw, "trades": trades, "kv": [["m15_selftest_kv", "1"]],
            "calls": [["st-1", "TP1", 1.5, {"closed_pnl_usd": 4.7}], ["st-2", "SKIP", 0.0, {"skip_reason": "selftest_" + "x" * 80}],
                      ["st-3", "SL", -1.0, {}]],
            "rows": [{k: r[k] for k in ("trade_id", "result", "result_rr", "state", "skip_reason", "closed_pnl_usd")} if r else None
                     for r in rows],
            "dump": dump_db(t_ref=t, trade_ids=["st-1", "st-2", "st-3"], kv_prefix="m15_selftest"),
            "logs": [[ln["level"], ln["msg"]] for ln in LOGS.take() if ln["level"] in ("WARNING", "ERROR", "CRITICAL")]}


def self_test():
    """Run the harness self-test on a fresh VLoop; raises if the harness misbehaves. Returns the record."""
    return run(self_test_async)


async def self_test_async():
    """The self-test inside a running VLoop (its fakes are removed again at the end)."""
    rec = await _selftest_body()
    sems = await _selftest_semaphores()
    rec["db"] = await _selftest_db()
    rec["ties"] = await _selftest_ties()
    o = {r[0]: r for r in rec["out"]}
    # the harness contract, checked on the Python side
    assert o["bybit.get_positions"][3] == 0.0, o["bybit.get_positions"]
    assert o["okx.get_positions"][1] is None and o["okx.get_positions"][2] == ["code: 50001 Service temporarily unavailable"]
    assert o["bingx.timeout"][1] == 6.0, o.get("bingx.timeout")
    assert "positional argument" in o["binance.get_open_orders.TypeError"][1], o["binance.get_open_orders.TypeError"]
    assert o["binance.cancel_all_orders"][2] == 8.5, o["binance.cancel_all_orders"]
    assert o["bybit.is_delisted"][1:] == [False, True, True]
    assert [g[0] for g in o["gather"][1]] == ["a", "b"] and o["gather"][1][0][2] == 9.5 and o["gather"][1][1][2] == 11.5
    assert o["after_sleep"][1] == 21.5 and o["after_sleep"][2] == 21.5
    assert [c["task"] for c in rec["calls"] if c["fn"] == "get_open_orders"] == ["slv_a", "slv_b"]
    assert not rec["errors"], rec["errors"]
    assert len(rec["bind_errors"]) == 1
    for n in (4, 8, 16):
        assert rec["ties"][f"sleep_{n}"] == [f"t{i}" for i in range(1, n + 1)], rec["ties"]
    assert rec["ties"]["call_later"] == [f"c{i}@{d}" for d in (1, 2, 3) for i, dd in enumerate(rec["ties"]["call_later_delays"]) if dd == d]
    assert [r["args"][0] for r in rec["recorded"][:2]] == [{"__bot__": True}] * 2, rec["recorded"]
    assert rec["recorded"][1]["kwargs"]["notify"] == {"__bot__": True}
    assert rec["recorded"][2]["kwargs"]["tags"] == {"obj": {"__obj__": "object"}, "fn": {"__obj__": "function"}}, rec["recorded"]
    by_name = {s["name"]: s for s in sems}
    assert by_name["fifo_2_of_5"]["acquire_order"] == ["t1", "t2", "t3", "t4", "t5"]
    assert by_name["cancel_queued"]["acquire_order"] == ["a", "b", "d"]
    assert by_name["verifier_5_of_12"]["peak"] == 5
    assert by_name["tie_wake_3_of_6"]["acquire_order"] == ["t0", "t5", "t1", "t2", "t3", "t4"], by_name["tie_wake_3_of_6"]
    assert by_name["tie_8_of_3"]["acquire_order"] == [f"w{i}" for i in range(1, 9)]
    dev = by_name["same_instant_cancel"]
    assert dev["traces"]["b"] == [[1.0, "want"], [10.0, "cancelled"]] and dev["acquire_order"] == ["a", "c"], dev
    assert by_name["same_instant_cancel_guarded"]["refused"], by_name["same_instant_cancel_guarded"]
    assert all(not s.get("refused") for s in sems if s["name"] != "same_instant_cancel_guarded"), [s["name"] for s in sems if s.get("refused")]
    rec["semaphores"] = sems
    assert not _ADDRESS.search(json.dumps(jsonable(rec))), "a memory address in the self-test record"
    return rec
