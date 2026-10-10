"""gen_m15_loop_trace.py — PLAN_M15 U2 vectors: the bot's REAL trade-ops loop shells on a virtual clock.

Writes backend/tests/autotrade/m15/fixtures/m15_loop_trace.json.gz for tests/autotrade/m15/loopTrace.test.js
and runtime.test.js. Bot HEAD 1a47ffc (claude/funny-edison-529rg1), CPython 3.11, m15_harness VLoop.

Real bot code:
  bot.py main() nested functions, ast-extracted verbatim: _guarded, _guarded_restart, _run_state_reconciliation,
  _run_trade_state_cleanup, _run_anomaly_detector (the swallowing wrappers 1506-1535);
  auto_trade.state_reconciliation_loop / trade_state_cleanup_loop, trade_anomaly_detector.run_detector_loop +
  _record_metrics, sl_verifier.sl_verifier_loop (its Semaphore(5) + gather), orphan_sweeper.orphan_sweeper_loop
  (+ its import-time env, importlib.reload per env scenario; its [HEALTH-MON] `import bot` finds the bot module
  this driver imported first — `health` is a local of main(), so nothing heartbeats ORPHAN, Q-S12);
  scanner_mid.MidScanner.run_forever ([BE-SINGLE-LOOP 2026-10]) on a MidScanner.__new__ instance.

Stubbed (each call recorded at its virtual instant, behaviour scripted per call number — the same scripts drive
the JS twin): auto_trade._reconcile_once, database.db_cleanup_stuck_placing, trade_anomaly_detector._run_once,
metrics.record, database.db_get_open_trades_all, sl_verifier._check_single_trade, database.db_get_all_users,
orphan_sweeper._sweep_one_user; for the BE trace the instance's _scan_loop / _sub_check_loop / _be_monitor_loop
(scripted crashes / returns, the g5 test pattern) and a stub ws_feed module. A stub "behaviour" = sleep `dur`
(a cancellation point), then raise `raise` or return `ret` / `stats` / `trades` / `users`.

Sections:
  main          the five loops in the bot's gather order under their bot.py wrappers, 6 h + 0.0625 s of virtual
                time with pass exceptions (incl. a TimeoutError — C-15), the detector's WARNING / DEBUG pass lines,
                the verifier's empty / raising reads and per-trade errors (Semaphore(5) hand-overs), the sweeper's
                key pre-filter, per-user errors (KeyError, int += str, None result), a users-read error and an
                iteration error with the 3600 s back-off; then every task cancelled (the bot's shutdown)
  cancels       one task.cancel() per loop per scenario at an anchored instant: inside a pass, inside the gather,
                in the first delay, in the interval sleep, in the verifier's "no open trades" sleep, in the
                sweeper's 0.3 s pause / interval sleep / 3600 s back-off / warm-up (C-9: which ones print the
                "stopped" line)
  sweeper_env   ORPHAN_SWEEP_ENABLED = 0 / " 0 " / "  0\n" / false and ORPHAN_SWEEP_INTERVAL_S=60
  wrappers      the loop function itself raising: reconcile / cleanup / detector → the wrapper's "crashed"
                line and a clean return (no 💀, no restart, INF-Q-I3); the verifier under _guarded_restart
                (restart + 💀 + backoff) and the sweeper under _guarded (💀 "Задача упала", no restart)
  env_parse     orphan_sweeper's import-time int() / strip() of ORPHAN_SWEEP_* (reload per value; D24 table)
  be            MidScanner.run_forever under the real _guarded_restart: LEVELS crashes reuse the live BE loop
                ([BE-SINGLE-LOOP] line per reuse), a crashed / finished BE loop is started again, a BE crash
                during the restart backoff, start order scan → sub → BE, cancellation reaches the reused BE task

Run:
  cd /home/user/MAIN_BOT/CHM_BREAKER_V4
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> -I -B <site>/backend/tests/autotrade/m15/py/gen_m15_loop_trace.py [OUT]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import m15_harness as H  # noqa: E402  (sandbox + virtual clock first)

import ast  # noqa: E402
import asyncio  # noqa: E402
import copy  # noqa: E402
import hashlib  # noqa: E402
import html as _html  # noqa: E402
import importlib  # noqa: E402
import logging  # noqa: E402
import textwrap  # noqa: E402
import time  # noqa: E402
import types  # noqa: E402

OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(H.FIXTURES, "m15_loop_trace.json.gz")

import database  # noqa: E402
import auto_trade  # noqa: E402
import trade_anomaly_detector as tad  # noqa: E402
import sl_verifier  # noqa: E402
import orphan_sweeper  # noqa: E402
import metrics  # noqa: E402
import scanner_mid  # noqa: E402
import bot as _bot_module  # noqa: E402,F401  (the module the sweeper's `import bot` returns; its import-time lines dropped)

H.LOGS.take()

LOOP_TASKS = ["state_reconcile", "trade_state_cleanup", "anomaly_detector", "sl_verifier", "orphan_sweeper"]

# ── bot.py main() nested wrappers, verbatim ──────────────────────────────────
NESTED = ["_guarded", "_guarded_restart", "_run_state_reconciliation", "_run_trade_state_cleanup", "_run_anomaly_detector"]
SINK: list = []
REC_BOT = H.RecBot(SINK)
UM = types.SimpleNamespace(name="um")
_src = open(os.path.join(H.BOT, "bot.py"), encoding="utf-8").read()
_tree = ast.parse(_src)
_main = next(n for n in _tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "main")
NS = {"asyncio": asyncio, "log": logging.getLogger("CHM.Main"), "config": types.SimpleNamespace(ADMIN_IDS=[123]),
      "bot": REC_BOT, "_html": _html, "time": time}
SOURCES = {}
for _n in ast.walk(_main):
    if isinstance(_n, (ast.FunctionDef, ast.AsyncFunctionDef)) and _n.name in NESTED and _n.name not in SOURCES:
        _seg = textwrap.dedent(ast.get_source_segment(_src, _n))
        exec(compile(_seg, f"bot.py:{_n.name}", "exec"), NS)  # noqa: S102
        SOURCES[_n.name] = _seg
assert set(SOURCES) == set(NESTED), set(NESTED) - set(SOURCES)

# ── recording ────────────────────────────────────────────────────────────────
EVENTS: list = []
CANCELS: list = []
TASKS: dict = {}
ANCHORS: list = []
CALLN: dict = {}


def rel():
    return H.CLK.wall - H.WALL0


def ev(fn, *args):
    EVENTS.append([rel(), H.task_name(), fn, H.jsonable(list(args))])


def _cancel(task):
    CANCELS.append([rel(), task, len(EVENTS), len(H.LOGS.lines)])
    TASKS[task].cancel()


def _anchor(fn, n, when):
    lp = asyncio.get_running_loop()
    for a in ANCHORS:
        if a.get("fn") == fn and a.get("call") == n and a.get("when", "start") == when:
            lp.call_later(a["offset"], _cancel, a["task"])


def _call(fn):
    CALLN[fn] = CALLN.get(fn, 0) + 1
    return CALLN[fn]


class Script:
    def __init__(self, spec):
        self.default = spec.get("default", {})
        self.calls = spec.get("calls", {})
        self.n = 0

    def next(self):
        self.n += 1
        b = dict(self.default)
        b.update(self.calls.get(str(self.n), {}))
        return self.n, b


async def behave(b):
    if b.get("dur"):
        await asyncio.sleep(b["dur"])
    if b.get("raise"):
        t, m = b["raise"]
        raise H.mk_exc({"type": t, "msg": m})


SC: dict = {}


async def stub_reconcile_once():
    n = _call("reconcile")
    ev("reconcile", n)
    _anchor("reconcile", n, "start")
    _, b = SC["reconcile"].next()
    try:
        await behave(b)
    finally:
        _anchor("reconcile", n, "end")


async def stub_cleanup_stuck_placing(max_age_seconds: int = 1800):
    n = _call("cleanup")
    ev("cleanup", n, max_age_seconds)
    _anchor("cleanup", n, "start")
    _, b = SC["cleanup"].next()
    try:
        await behave(b)
    finally:
        _anchor("cleanup", n, "end")
    return copy.deepcopy(b.get("ret", []))


async def stub_run_once(bot):
    n = _call("detector")
    if bot is not REC_BOT:
        raise H.HarnessError("run_detector_loop passed another bot to _run_once")
    ev("detector", n)
    _anchor("detector", n, "start")
    _, b = SC["detector"].next()
    try:
        await behave(b)
    finally:
        _anchor("detector", n, "end")
    return copy.deepcopy(b["stats"])


async def stub_metrics_record(name, value, *a, **k):
    ev("metrics", name, value)


async def stub_open_trades_all():
    n = _call("open_trades")
    ev("open_trades", n)
    _anchor("open_trades", n, "start")
    _, b = SC["open_trades"].next()
    try:
        await behave(b)
    finally:
        _anchor("open_trades", n, "end")
    return copy.deepcopy(b.get("trades", []))


async def stub_check_single_trade(bot, um, trade):
    n = _call("check")
    tid = trade.get("trade_id")
    if bot is not REC_BOT or um is not UM:
        raise H.HarnessError("sl_verifier_loop passed another bot / um to _check_single_trade")
    ev("check", n, tid)
    _anchor("check", n, "start")
    b = dict(SC["checks"].get(tid, {}))
    try:
        await behave(b)
    finally:
        ev("check_end", n, tid)
        _anchor("check", n, "end")


async def stub_get_all_users():
    n = _call("users")
    ev("users", n)
    _anchor("users", n, "start")
    _, b = SC["users"].next()
    try:
        await behave(b)
    finally:
        _anchor("users", n, "end")
    return copy.deepcopy(b.get("users", []))


async def stub_sweep_one_user(user_row: dict) -> dict:
    n = _call("sweep")
    uid = user_row.get("user_id")
    ev("sweep", n, uid)
    _anchor("sweep", n, "start")
    b = dict(SC["sweeps"].get(str(uid), SC["sweeps"].get("default", {})))
    try:
        await behave(b)
    finally:
        ev("sweep_end", n, uid)
        _anchor("sweep", n, "end")
    return copy.deepcopy(b.get("ret"))


def install_stubs():
    auto_trade._reconcile_once = stub_reconcile_once
    database.db_cleanup_stuck_placing = stub_cleanup_stuck_placing
    tad._run_once = stub_run_once
    metrics.record = stub_metrics_record
    database.db_get_open_trades_all = stub_open_trades_all
    sl_verifier._check_single_trade = stub_check_single_trade
    database.db_get_all_users = stub_get_all_users
    orphan_sweeper._sweep_one_user = stub_sweep_one_user


def reload_sweeper(**env):
    for k in ("ORPHAN_SWEEP_INTERVAL_S", "ORPHAN_SWEEP_MIN_ORDER_AGE_S", "ORPHAN_SWEEP_RECENT_OPEN_S", "ORPHAN_SWEEP_ENABLED"):
        os.environ.pop(k, None)
    H.set_env(**env)
    importlib.reload(orphan_sweeper)
    orphan_sweeper._sweep_one_user = stub_sweep_one_user


ORIG = {
    "state_reconciliation_loop": auto_trade.state_reconciliation_loop,
    "trade_state_cleanup_loop": auto_trade.trade_state_cleanup_loop,
    "run_detector_loop": tad.run_detector_loop,
    "sl_verifier_loop": sl_verifier.sl_verifier_loop,
}


def make_coros(loops):
    """The bot.py gather entries of the five loops (bot.py:1647-1652, 1704), in that order."""
    g, gr = NS["_guarded"], NS["_guarded_restart"]
    out = {
        "state_reconcile": lambda: g("state_reconcile", NS["_run_state_reconciliation"]()),
        "trade_state_cleanup": lambda: g("trade_state_cleanup", NS["_run_trade_state_cleanup"]()),
        "anomaly_detector": lambda: gr("anomaly_detector", lambda: NS["_run_anomaly_detector"]()),
        "sl_verifier": lambda: gr("sl_verifier", lambda: __import__("sl_verifier").sl_verifier_loop(REC_BOT, UM)),
        "orphan_sweeper": lambda: g("orphan_sweeper", __import__("orphan_sweeper").orphan_sweeper_loop(REC_BOT)),
    }
    return [(name, out[name]) for name in LOOP_TASKS if name in loops]


def _check_no_ties(cancels, events, log_lines):
    """A cancel must not share its instant with an earlier step of the SAME task at that instant (a stub end,
    i.e. a semaphore release, a log line): the JS twin schedules its aborts up front, the bot at run time, so
    only the cancelled task's own same-instant order could differ. What follows the cancel at that instant is
    its consequence (the stopped line, the stubs' `finally`); other tasks' steps there do not interact."""
    for t, task, n_ev, n_log in cancels:
        clash = [e for e in events[:n_ev] if e[0] == t and e[1] == task]
        clash += [ln for ln in log_lines[:n_log] if ln["t"] - H.WALL0 == t and ln["task"] == task]
        if clash:
            raise H.HarnessError(f"cancel of {task} at {t} ties with {clash[:3]}")


async def run_loops(spec):
    """One scenario: the selected loops from t = 0 (bot gather order), anchored / absolute cancels, then every
    task still running cancelled at the horizon (the bot's shutdown: cancel all, then wait)."""
    global ANCHORS
    H.CLK.wall, H.CLK.mono = H.WALL0, H.MONO0
    EVENTS.clear()
    CANCELS.clear()
    TASKS.clear()
    CALLN.clear()
    SINK.clear()
    H.LOGS.take()
    SC.clear()
    SC.update({k: Script(spec["scripts"].get(k, {})) for k in ("reconcile", "cleanup", "detector", "open_trades", "users")})
    SC["checks"] = spec["scripts"].get("checks", {})
    SC["sweeps"] = spec["scripts"].get("sweeps", {})
    ANCHORS = [a for a in spec.get("cancels", []) if "fn" in a]
    lp = asyncio.get_running_loop()
    for name, mk in make_coros(spec["loops"]):
        TASKS[name] = asyncio.create_task(mk(), name=name)
    for a in spec.get("cancels", []):
        if "at" in a:
            lp.call_at(H.MONO0 + a["at"], _cancel, a["task"])
    await asyncio.sleep(spec["horizon"])
    done_at = {}
    for name, t in TASKS.items():
        if t.done():
            done_at[name] = True
    final = rel()
    for name, t in TASKS.items():
        if not t.done():
            t.cancel()
    await asyncio.gather(*TASKS.values(), return_exceptions=True)
    for _ in range(5):
        await asyncio.sleep(0)
    raw_logs = H.LOGS.take()
    logs = [[ln["t"] - H.WALL0, ln["task"], ln["level"], ln["msg"], ln["exc"]] for ln in raw_logs]
    events = list(EVENTS)
    _check_no_ties(CANCELS, events, raw_logs)
    states = {name: ("cancelled" if t.cancelled() else ("error: " + repr(t.exception()) if t.exception() else "done")) for name, t in TASKS.items()}
    return {
        "spec": spec, "events": events, "logs": logs, "cancels": [c[:2] for c in CANCELS], "final_cancel": final,
        "done_before_final": sorted(done_at), "task_states": states,
        "alerts": [[a["t"] - H.WALL0, a["task"], a["uid"], a["text"]] for a in SINK],
    }


# ── scenario scripts ─────────────────────────────────────────────────────────
STATS0 = {"checked_positions": 3, "missing_sl_found": 0, "price_past_sl_found": 0}
U = {
    1: {"user_id": 1, "trade_exchange": "bybit", "bybit_api_key": "k1"},
    2: {"user_id": 2, "trade_exchange": "bybit", "bybit_api_key": ""},
    3: {"user_id": 3, "trade_exchange": "bingx", "bingx_api_key": "k3", "bybit_api_key": ""},
    4: {"user_id": 4, "trade_exchange": "", "bybit_api_key": "k4"},
    5: {"user_id": 5, "trade_exchange": None, "bybit_api_key": "k5"},
    6: {"user_id": 6, "trade_exchange": "BINGX", "bingx_api_key": "k6"},
    7: {"user_id": 7, "trade_exchange": "okx", "okx_api_key": "k7"},
    8: {"user_id": 8, "trade_exchange": "binance", "binance_api_key": "k8"},
    9: {"user_id": 9, "trade_exchange": "bybit", "bybit_api_key": "k9"},
    10: {"user_id": 10, "trade_exchange": "bybit", "bybit_api_key": "k10"},
    11: {"user_id": 11, "bybit_api_key": "k11"},
}
TR = {i: {"trade_id": f"T{i}", "user_id": 100 + i, "symbol": f"C{i}-USDT-SWAP"} for i in range(1, 10)}

MAIN = {
    "name": "main", "loops": LOOP_TASKS, "horizon": 6 * 3600 + 0.0625,
    "scripts": {
        "reconcile": {"default": {"dur": 1.2}, "calls": {
            "3": {"dur": 0.4, "raise": ["RuntimeError", "reconcile boom"]},
            "5": {"dur": 0.0},
            "8": {"raise": ["TimeoutError", ""]},
            "11": {"dur": 2.0, "raise": ["ValueError", "bad row"]},
        }},
        "cleanup": {"default": {"dur": 0.4, "ret": []}, "calls": {
            "2": {"raise": ["RuntimeError", "database is locked"]},
            "4": {"dur": 0.0},
        }},
        "detector": {"default": {"dur": 0.4, "stats": STATS0}, "calls": {
            "4": {"dur": 0.2, "raise": ["RuntimeError", "detector boom"]},
            "6": {"stats": {"checked_positions": 3, "missing_sl_found": 1, "price_past_sl_found": 0}},
            "9": {"dur": 1.6, "stats": {"checked_positions": 4, "missing_sl_found": 0, "price_past_sl_found": 2}},
            "13": {"raise": ["TimeoutError", ""]},
            "20": {"dur": 3.1},
            "31": {"stats": {"checked_positions": 0, "missing_sl_found": 0, "price_past_sl_found": 0}},
        }},
        "open_trades": {"default": {"trades": [TR[1], TR[2], TR[3]]}, "calls": {
            "1": {"trades": [TR[i] for i in range(1, 8)]},
            "2": {"trades": []},
            "3": {"raise": ["RuntimeError", "db gone"]},
            "5": {"dur": 0.0, "trades": [TR[i] for i in (9, 8, 7, 6, 5, 4)]},
        }},
        "checks": {
            "T1": {"dur": 3.0}, "T2": {"dur": 1.0}, "T3": {"dur": 2.0, "raise": ["ValueError", "bad sl"]},
            "T4": {"dur": 5.0}, "T5": {"dur": 1.0, "raise": ["TimeoutError", ""]}, "T6": {"dur": 0.0},
            "T7": {"dur": 2.0}, "T8": {"dur": 4.0}, "T9": {"dur": 1.0, "raise": ["AttributeError", "'NoneType' object has no attribute 'get'"]},
        },
        "users": {"default": {"users": [U[1], U[3]]}, "calls": {
            "1": {"users": [U[1], U[2], U[3], U[4], U[5], U[6], U[11]]},
            "2": {"raise": ["RuntimeError", "users read failed"]},
            "3": {"users": [U[1], U[7], U[8], U[9], U[10]]},
            "4": {"users": [None, U[1]]},
            "6": {"users": []},
        }},
        "sweeps": {
            "1": {"dur": 0.4, "ret": {"checked": 2, "cancelled": 1, "errors": 0}},
            "3": {"dur": 0.2, "ret": {"checked": 1, "cancelled": 0, "errors": 1}},
            "4": {"ret": {"checked": True, "cancelled": 0, "errors": 0}},
            "5": {"dur": 0.1, "ret": {"checked": 0, "cancelled": 0, "errors": 0}},
            "11": {"ret": {"checked": 3, "cancelled": 2, "errors": 0}},
            "7": {"dur": 0.3, "ret": {"checked": 1}},
            "8": {"ret": {"checked": "x", "cancelled": 0, "errors": 0}},
            "9": {"dur": 0.1, "raise": ["RuntimeError", "sweep failed"]},
            "10": {"ret": None},
        },
    },
}

PASS1 = {"dur": 1.0}
SIMPLE = {
    "reconcile": {"default": PASS1}, "cleanup": {"default": {"dur": 1.0, "ret": []}},
    "detector": {"default": {"dur": 1.0, "stats": STATS0}},
    "open_trades": {"default": {"trades": [TR[1], TR[2], TR[3]]}},
    "checks": {"T1": {"dur": 1.0}, "T2": {"dur": 2.0}, "T3": {"dur": 3.0}},
    "users": {"default": {"users": [U[1], U[3]]}}, "sweeps": {"default": {"dur": 1.0, "ret": {"checked": 1, "cancelled": 0, "errors": 0}}},
}

CANCEL_SCENARIOS = [
    {"name": "cancel_in_pass", "loops": LOOP_TASKS, "horizon": 2000.0, "scripts": SIMPLE, "cancels": [
        {"task": "state_reconcile", "fn": "reconcile", "call": 2, "when": "start", "offset": 0.5},
        {"task": "trade_state_cleanup", "fn": "cleanup", "call": 1, "when": "start", "offset": 0.5},
        {"task": "anomaly_detector", "fn": "detector", "call": 2, "when": "start", "offset": 0.5},
        {"task": "sl_verifier", "fn": "check", "call": 4, "when": "start", "offset": 0.5},
        {"task": "orphan_sweeper", "fn": "sweep", "call": 2, "when": "start", "offset": 0.5},
    ]},
    {"name": "cancel_in_sleep", "loops": LOOP_TASKS, "horizon": 2500.0, "scripts": dict(SIMPLE, open_trades={"default": {"trades": [TR[1]]}}), "cancels": [
        {"task": "state_reconcile", "fn": "reconcile", "call": 2, "when": "end", "offset": 10.5},
        {"task": "trade_state_cleanup", "fn": "cleanup", "call": 1, "when": "end", "offset": 100.5},
        {"task": "anomaly_detector", "fn": "detector", "call": 3, "when": "end", "offset": 5.5},
        {"task": "sl_verifier", "fn": "check", "call": 1, "when": "end", "offset": 20.5},
        # after the last user's sweep end: the 0.3 s pause, the CYCLE line, then the interval sleep
        {"task": "orphan_sweeper", "fn": "sweep", "call": 2, "when": "end", "offset": 50.5},
    ]},
    {"name": "cancel_special", "loops": LOOP_TASKS, "horizon": 1500.0,
     "scripts": dict(SIMPLE, open_trades={"default": {"trades": []}}), "cancels": [
        {"task": "state_reconcile", "at": 30.5},
        {"task": "trade_state_cleanup", "at": 59.5},
        {"task": "anomaly_detector", "at": 10.5},
        # the verifier's "no open trades" sleep is INSIDE the try (C-9: the stopped line)
        {"task": "sl_verifier", "fn": "open_trades", "call": 1, "when": "end", "offset": 10.5},
        # the 0.3 s pause after a user (inside the try)
        {"task": "orphan_sweeper", "fn": "sweep", "call": 1, "when": "end", "offset": 0.1},
    ]},
    {"name": "cancel_backoff", "loops": ["sl_verifier", "orphan_sweeper"], "horizon": 5000.0,
     "scripts": dict(SIMPLE, users={"default": {"users": [None]}}), "cancels": [
        {"task": "sl_verifier", "at": 59.5},
        # the 3600 s back-off after an iteration error is OUTSIDE the try: silent
        {"task": "orphan_sweeper", "fn": "users", "call": 1, "when": "end", "offset": 100.5},
    ]},
    {"name": "cancel_warmup", "loops": ["orphan_sweeper"], "horizon": 500.0, "scripts": SIMPLE, "cancels": [
        {"task": "orphan_sweeper", "at": 60.5},
    ]},
]

SWEEPER_ENV = [
    {"name": "enabled_0", "env": {"ORPHAN_SWEEP_ENABLED": "0"}, "horizon": 400.0},
    {"name": "enabled_space_0", "env": {"ORPHAN_SWEEP_ENABLED": " 0 "}, "horizon": 400.0},
    {"name": "enabled_unicode_space_0", "env": {"ORPHAN_SWEEP_ENABLED": "  0\n"}, "horizon": 400.0},
    {"name": "enabled_false", "env": {"ORPHAN_SWEEP_ENABLED": "false"}, "horizon": 1000.0},
    {"name": "interval_60", "env": {"ORPHAN_SWEEP_INTERVAL_S": "60", "ORPHAN_SWEEP_MIN_ORDER_AGE_S": " +90 ",
                                     "ORPHAN_SWEEP_RECENT_OPEN_S": "1_200"}, "horizon": 600.0},
]

INT_RAWS = ["300", " 60 ", "+5", "-5", "0", "00", "1_000", "1__000", "_1", "1_", "0x10", "0o17", "5.0", "", " ", "abc",
            "1e3", "\t42\n", "٣٠٠", "３００", "  7  ", "99999999999999999999",
            "9007199254740991", "9007199254740992", "-9007199254740991", "12abc", "٣_٠"]
ENABLED_RAWS = ["0", " 0 ", "  0\n", "false", "", "00", "1", "0.0", "no", " 0", "o"]


def env_parse():
    rows = []
    for name in ("ORPHAN_SWEEP_INTERVAL_S", "ORPHAN_SWEEP_MIN_ORDER_AGE_S", "ORPHAN_SWEEP_RECENT_OPEN_S"):
        for raw in INT_RAWS:
            rows.append(_env_row({name: raw}))
    for raw in ENABLED_RAWS:
        rows.append(_env_row({"ORPHAN_SWEEP_ENABLED": raw}))
    # the first failing int wins (import order), and ENABLED=0 does not save a malformed int (C-16)
    rows.append(_env_row({"ORPHAN_SWEEP_INTERVAL_S": "abc", "ORPHAN_SWEEP_MIN_ORDER_AGE_S": "x"}))
    rows.append(_env_row({"ORPHAN_SWEEP_MIN_ORDER_AGE_S": "x", "ORPHAN_SWEEP_RECENT_OPEN_S": "y"}))
    rows.append(_env_row({"ORPHAN_SWEEP_ENABLED": "0", "ORPHAN_SWEEP_INTERVAL_S": "abc"}))
    rows.append(_env_row({}))
    reload_sweeper()
    return rows


def _env_row(env):
    try:
        reload_sweeper(**env)
        return {"env": env, "ok": True, "interval_s": repr(orphan_sweeper.ORPHAN_SWEEP_INTERVAL_S),
                "min_order_age_s": repr(orphan_sweeper.ORPHAN_SWEEP_MIN_ORDER_AGE_S),
                "recent_open_s": repr(orphan_sweeper.ORPHAN_SWEEP_RECENT_OPEN_S),
                "enabled": orphan_sweeper.ORPHAN_SWEEP_ENABLED}
    except Exception as e:  # noqa: BLE001
        return {"env": env, "ok": False, "type": type(e).__name__, "msg": str(e)}


# ── wrappers: the loop function itself raising ───────────────────────────────
def _raising(label, after, times=None):
    st = {"n": 0}

    async def loop(*a, **k):
        st["n"] += 1
        ev("loop_start", label, st["n"])
        if times is not None and st["n"] > times:
            await asyncio.sleep(10 ** 6)
            return
        await asyncio.sleep(after)
        ev("loop_raise", label, st["n"])
        raise RuntimeError(f"{label} exploded <#{st['n']}>")
    return loop


async def wrappers_scenario():
    auto_trade.state_reconciliation_loop = _raising("reconcile", 5.0)
    auto_trade.trade_state_cleanup_loop = _raising("cleanup", 7.0)
    tad.run_detector_loop = _raising("detector", 9.0)
    sl_verifier.sl_verifier_loop = _raising("verifier", 11.0, times=2)
    orig_sweeper = orphan_sweeper.orphan_sweeper_loop
    orphan_sweeper.orphan_sweeper_loop = _raising("sweeper", 13.0)
    try:
        spec = {"name": "wrappers", "loops": LOOP_TASKS, "horizon": 200.0, "scripts": {}}
        return await run_loops(spec)
    finally:
        auto_trade.state_reconciliation_loop = ORIG["state_reconciliation_loop"]
        auto_trade.trade_state_cleanup_loop = ORIG["trade_state_cleanup_loop"]
        tad.run_detector_loop = ORIG["run_detector_loop"]
        sl_verifier.sl_verifier_loop = ORIG["sl_verifier_loop"]
        orphan_sweeper.orphan_sweeper_loop = orig_sweeper


# ── BE trace: MidScanner.run_forever [BE-SINGLE-LOOP] ────────────────────────
BE_SCENARIOS = [
    # two LEVELS (scan) crashes: the live BE loop is reused twice; a third crash after a ≥ 300 s run resets the backoff
    {"name": "levels_crashes", "horizon": 1500.0, "scan_crash": {"1": 30.0, "2": 30.0, "3": 400.0}, "be": {}},
    # the BE loop crashes: the next run_forever starts a new one
    {"name": "be_crash", "horizon": 600.0, "scan_crash": {}, "be": {"1": {"after": 50.0, "what": "crash"}}},
    # BE crash in run 1, then a LEVELS crash in run 2: run 3 reuses run 2's BE loop
    {"name": "be_crash_then_levels", "horizon": 800.0, "scan_crash": {"2": 30.0}, "be": {"1": {"after": 50.0, "what": "crash"}}},
    # the BE loop returned (stop-event style): the next run_forever starts it again
    {"name": "be_finished", "horizon": 600.0, "scan_crash": {"1": 100.0}, "be": {"1": {"after": 40.0, "what": "return"}}},
    # the BE loop crashes while orphaned — during the restart backoff after a LEVELS crash
    {"name": "be_crash_during_backoff", "horizon": 600.0, "scan_crash": {"1": 30.0}, "be": {"1": {"after": 35.0, "what": "crash"}}},
]


class BeLoops:
    def __init__(self, spec):
        self.spec = spec
        self.scan_calls = 0
        self.sub_calls = 0
        self.be_starts = 0
        self.be_live = 0

    async def scan(self):
        self.scan_calls += 1
        n = self.scan_calls
        ev("scan.start", n)
        crash = self.spec["scan_crash"].get(str(n))
        if crash is not None:
            await asyncio.sleep(crash)
            ev("scan.crash", n)
            raise RuntimeError(f"scan crash #{n}")
        await asyncio.sleep(10 ** 6)

    async def sub(self):
        self.sub_calls += 1
        ev("sub.start", self.sub_calls)
        await asyncio.sleep(10 ** 6)

    async def be(self):
        self.be_starts += 1
        n = self.be_starts
        self.be_live += 1
        ev("be.start", n, self.be_live)
        try:
            b = self.spec["be"].get(str(n))
            if b:
                await asyncio.sleep(b["after"])
                if b["what"] == "crash":
                    ev("be.crash", n)
                    raise RuntimeError(f"be crash #{n}")
                ev("be.return", n)
                return
            await asyncio.sleep(10 ** 6)
        except asyncio.CancelledError:
            ev("be.cancelled", n)
            raise
        finally:
            self.be_live -= 1


async def be_scenario(spec):
    H.CLK.wall, H.CLK.mono = H.WALL0, H.MONO0
    EVENTS.clear()
    SINK.clear()
    H.LOGS.take()
    fake_ws = types.ModuleType("ws_feed")
    fake_ws.register_on_bar_close = lambda cb: None
    saved_ws = sys.modules.get("ws_feed")
    sys.modules["ws_feed"] = fake_ws
    try:
        loops = BeLoops(spec)
        sc = scanner_mid.MidScanner.__new__(scanner_mid.MidScanner)
        sc.cfg = types.SimpleNamespace(SCAN_WORKERS=10, API_CONCURRENCY=12)

        async def _no_warmup():
            return None
        sc._warmup_cache = _no_warmup
        sc._scan_loop = loops.scan
        sc._sub_check_loop = loops.sub
        sc._be_monitor_loop = loops.be
        task = asyncio.create_task(NS["_guarded_restart"]("scanner", lambda: sc.run_forever()), name="scanner")
        await asyncio.sleep(spec["horizon"])
        ev("cancel")
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        for _ in range(5):
            await asyncio.sleep(0)
        logs = [[ln["t"] - H.WALL0, ln["level"], ln["msg"], ln["exc"]] for ln in H.LOGS.take() if ln["level"] != "DEBUG"]
        return {"spec": spec, "events": list(EVENTS), "logs": logs, "be_live_after": loops.be_live,
                "be_starts": loops.be_starts, "scan_calls": loops.scan_calls,
                "alerts": [[a["t"] - H.WALL0, a["uid"], a["text"]] for a in SINK]}
    finally:
        if saved_ws is not None:
            sys.modules["ws_feed"] = saved_ws
        else:
            sys.modules.pop("ws_feed", None)


def _sha(fn):
    import inspect
    return hashlib.sha1(textwrap.dedent(inspect.getsource(fn)).encode()).hexdigest()


async def amain():
    install_stubs()
    reload_sweeper()
    fixture = {"python": sys.version.split()[0], "bot_head": "1a47ffc", "wall0": H.WALL0, "mono0": H.MONO0}
    fixture["main"] = await run_loops(MAIN)
    fixture["cancels"] = [await run_loops(s) for s in CANCEL_SCENARIOS]
    env_runs = []
    for s in SWEEPER_ENV:
        reload_sweeper(**s["env"])
        r = await run_loops({"name": s["name"], "loops": ["orphan_sweeper"], "horizon": s["horizon"], "scripts": SIMPLE})
        r["env"] = s["env"]
        env_runs.append(r)
    reload_sweeper()
    fixture["sweeper_env"] = env_runs
    fixture["wrappers"] = await wrappers_scenario()
    fixture["env_parse"] = env_parse()
    fixture["be"] = [await be_scenario(s) for s in BE_SCENARIOS]
    fixture["sources_sha"] = {k: hashlib.sha1(v.encode()).hexdigest() for k, v in sorted(SOURCES.items())}
    fixture["loops_sha"] = {
        "state_reconciliation_loop": _sha(ORIG["state_reconciliation_loop"]),
        "trade_state_cleanup_loop": _sha(ORIG["trade_state_cleanup_loop"]),
        "run_detector_loop": _sha(ORIG["run_detector_loop"]),
        "_record_metrics": _sha(tad._record_metrics),
        "sl_verifier_loop": _sha(ORIG["sl_verifier_loop"]),
        "orphan_sweeper_loop": _sha(orphan_sweeper.orphan_sweeper_loop),
        "run_forever": _sha(scanner_mid.MidScanner.run_forever),
    }
    return fixture


def main():
    fixture = H.run(amain)
    n = H.write_fixture(fixture, OUT)
    m = fixture["main"]
    print(f"m15 loop trace: main {len(m['events'])} events / {len(m['logs'])} logs, {len(fixture['cancels'])} cancel scenarios, "
          f"{len(fixture['sweeper_env'])} sweeper env runs, {len(fixture['env_parse'])} env rows, {len(fixture['be'])} BE scenarios "
          f"→ {OUT} ({n} bytes json)")


try:
    main()
    H.finish()
except BaseException:  # noqa: BLE001 — some bot module replaces sys.excepthook; print it here
    import traceback
    traceback.print_exc()
    sys.stderr.flush()
    try:
        H.finish()
    except BaseException as e:  # noqa: BLE001
        print(e, file=sys.stderr)
    os._exit(1)
sys.stdout.flush()
os._exit(0)
