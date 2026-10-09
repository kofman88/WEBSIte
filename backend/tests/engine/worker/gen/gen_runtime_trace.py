"""
gen_runtime_trace.py — two runtime semantics of the bot's loops on a virtual-time asyncio loop.

Runs the bot's own code (CPython 3.11, /home/user/MAIN_BOT/CHM_BREAKER_V4, read-only); the selector
advances the clock by the select timeout instead of blocking (as gen_scheduler_trace.py), so the
scenarios take milliseconds and every timer fires at its exact virtual instant.

  stall    health_monitor.HealthMonitor.run_forever() (120 s, then a check every 300 s) with the
           "LEVELS" heartbeat given once at t = 10 s, and a 2000 s event-loop stall at t = 1000 s
           (a synchronous callback that holds the loop: the virtual clock jumps, no timer runs in
           between). Shows what the bot does after a stall: the overdue sleep fires once, late, at
           the end of the stall, the loop then sleeps a full interval again (no catch-up burst), and
           the alert text carries the stall in its minutes. Records each admin alert [t, text].

  volume   volume_scanner.run_volume_scanner() with the REAL asyncio.wait_for (300 s cycle
           timeout) over a stub _scan_cycle: cycle 0 runs 6 steps of 70 s (it is cancelled inside its
           5th step, at t = 300 s), every later cycle one 10 s step. CPython 3.11 wait_for cancels the
           timed-out cycle and waits for it to end before raising TimeoutError (_cancel_and_wait,
           bpo-32751), so the [VOLUME-CYCLE] timeout warning and cycle 1 come after cycle 0 ended — the
           cycles never overlap. The task is cancelled at t = 600 s ("Volume scanner stopped.").
           Records [t, kind, cycle, step?] events, the heartbeats and the INFO+ log lines, also as one
           ordered timeline.

Output: ../fixtures/runtime_trace.json.

Run (from the bot directory, env BOT_TOKEN_CHM=test:token ADMIN_IDS=123):
  PYTHONDONTWRITEBYTECODE=1 <venv311>/bin/python -u <this file>
"""
import asyncio
import json
import logging
import os
import selectors
import sys
import time
import types

BOT_DIR = os.getcwd()
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "fixtures", "runtime_trace.json")

T0 = 1791565200.0            # 2026-10-09 17:00:00 UTC
STALL_AT = 1000.0
STALL_S = 2000.0
STALL_HORIZON = 4000.0
HB_AT = 10.0
VOL_STEP_S = 70.0
VOL_STEPS_FIRST = 6
VOL_STEP_LATER_S = 10.0
VOL_CANCEL_AT = 600.0


class Clock:
    t = 0.0


CLOCK = Clock()


class VirtualSelector(selectors.EpollSelector):
    def select(self, timeout=None):
        ready = super().select(0)
        if ready:
            return ready
        if timeout is None:
            return super().select(None)
        if timeout > 0:
            CLOCK.t += timeout
        return []


class VirtualLoop(asyncio.SelectorEventLoop):
    def __init__(self):
        super().__init__(VirtualSelector())

    def time(self):
        return CLOCK.t


time.time = lambda: T0 + CLOCK.t
time.monotonic = lambda: CLOCK.t


def rel():
    return round(CLOCK.t, 6)


LOGS = []
TIMELINE = []                # one ordered list: the volume scenario's events, heartbeats and log lines


class Capture(logging.Handler):
    def emit(self, record):
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001
            msg = str(record.msg)
        if record.levelno >= logging.INFO:
            LOGS.append([rel(), record.name, record.levelname, msg])
            TIMELINE.append([rel(), "log", record.levelname, msg])


root = logging.getLogger()
root.handlers[:] = []
root.addHandler(Capture())
root.setLevel(logging.DEBUG)

sys.path.insert(0, BOT_DIR)

import health_monitor  # noqa: E402
import volume_scanner  # noqa: E402
import ws_feed  # noqa: E402

for _n in list(logging.Logger.manager.loggerDict):
    _lg = logging.getLogger(_n)
    if isinstance(_lg, logging.Logger):
        _lg.handlers[:] = []
        _lg.propagate = True
        _lg.disabled = False
        _lg.setLevel(logging.NOTSET)


def run(coro_fn):
    CLOCK.t = 0.0
    LOGS.clear()
    TIMELINE.clear()
    loop = VirtualLoop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro_fn())
    finally:
        loop.close()


# ── stall ────────────────────────────────────────────────────────────────────

async def scenario_stall():
    alerts = []

    class Bot:
        async def send_message(self, chat_id, text, **kw):
            alerts.append([rel(), chat_id, text])

    hm = health_monitor.HealthMonitor(Bot(), types.SimpleNamespace(ADMIN_IDS=[123]))
    loop = asyncio.get_running_loop()
    loop.call_at(HB_AT, lambda: hm.heartbeat("LEVELS"))

    def stall():
        CLOCK.t += STALL_S          # the loop is held: nothing else runs until the callback returns

    loop.call_at(STALL_AT, stall)
    task = asyncio.ensure_future(hm.run_forever())
    await asyncio.sleep(STALL_HORIZON - CLOCK.t)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    return {"alerts": alerts, "logs": list(LOGS), "end_t": rel()}


# ── volume ───────────────────────────────────────────────────────────────────

async def scenario_volume():
    events = []
    st = {"n": 0}

    def ev(*a):
        events.append([rel(), *a])
        TIMELINE.append([rel(), *a])

    async def stub_cycle(bot, um, fetcher):
        n = st["n"]
        st["n"] += 1
        ev("start", n)
        steps, step_s = (VOL_STEPS_FIRST, VOL_STEP_S) if n == 0 else (1, VOL_STEP_LATER_S)
        try:
            for i in range(steps):
                await asyncio.sleep(step_s)
                ev("step", n, i)
        except asyncio.CancelledError:
            ev("cancelled", n)
            raise
        ev("end", n)

    beats = []

    def beat(name):
        beats.append([rel(), name])
        TIMELINE.append([rel(), "heartbeat", name])

    real_cycle = volume_scanner._scan_cycle
    real_reg = ws_feed.register_on_bar_close
    volume_scanner._scan_cycle = stub_cycle
    ws_feed.register_on_bar_close = lambda cb: None
    try:
        task = asyncio.ensure_future(volume_scanner.run_volume_scanner(
            None, None, None, health=types.SimpleNamespace(heartbeat=beat), interval_sec=60))
        await asyncio.sleep(VOL_CANCEL_AT)
        task.cancel()
        res = await asyncio.gather(task, return_exceptions=True)
    finally:
        volume_scanner._scan_cycle = real_cycle
        ws_feed.register_on_bar_close = real_reg
    return {"events": events, "beats": beats, "logs": list(LOGS), "timeline": list(TIMELINE), "end_t": rel(),
            "result": None if res[0] is None else type(res[0]).__name__}


out = {
    "generator": "gen_runtime_trace.py",
    "python": sys.version.split()[0],
    "scenario": {
        "t0": T0, "stall_at": STALL_AT, "stall_s": STALL_S, "stall_horizon": STALL_HORIZON, "hb_at": HB_AT,
        "vol_step_s": VOL_STEP_S, "vol_steps_first": VOL_STEPS_FIRST, "vol_step_later_s": VOL_STEP_LATER_S,
        "vol_cancel_at": VOL_CANCEL_AT, "volume_cycle_timeout_s": 300, "volume_interval_s": 60,
    },
    "stall": run(scenario_stall),
    "volume": run(scenario_volume),
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, indent=0, sort_keys=True)
print(f"stall alerts={len(out['stall']['alerts'])} volume events={len(out['volume']['events'])} -> {OUT}", flush=True)
sys.stdout.flush()
os._exit(0)
