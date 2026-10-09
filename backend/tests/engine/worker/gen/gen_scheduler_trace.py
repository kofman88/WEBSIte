"""
gen_scheduler_trace.py — which bot.py background loop fires when, over 6 simulated hours.

Runs the bot's own loop code (CPython 3.11, /home/user/MAIN_BOT/CHM_BREAKER_V4, read-only) on
a virtual-time asyncio event loop: the selector advances the clock by the select timeout instead
of blocking, `time.time` / `time.monotonic` / `free_report.datetime` read that clock, so 6 hours
take a fraction of a second and every timer fires at its exact virtual instant.

Real bot code:
  bot.py main() nested functions, extracted from the source with `ast` and exec'd in a namespace
  that supplies their closure names: _guarded, _guarded_restart, _start_ws_feed, _max_env_set,
  _start_cache_warmer, _coin_universe_warmup_loop, _ghost_cleanup_loop, _run_candle_prefetch;
  health_monitor.HealthMonitor; cache_gc.gc_loop; genome_maintenance.run_genome_maintenance_loop
  (+ _refresh_live_baseline_all); coin_quality_learner.coin_quality_loop;
  background_loops.regime_loop; momentum_detector.momentum_loop (+ check_macro_momentum,
  _last_closed_1h_via_fetcher); genome.genome_evolution_loop (+ _wait_for_low_load,
  _seconds_until_next_evolution, _mark_evolution_done); candle_store.candle_prefetch_loop;
  cache_warmer.CacheWarmer (start / _loop); smc.scanner.run_smc_scanner (+ _scan_cycle with no
  users); free_report.free_evening_report_loop (+ _send_evening_report); trend_monitor.
  trend_monitor_loop; signal_tracker.signal_tracker_loop.

Faked (recorded): the fetcher (get_all_usdt_pairs / get_candles), um (get_active_users /
all_users), bot.send_message (admin alerts), every DB call (kv get/set, ghost cleanup, trades GC
through a fake aiosqlite, coin-quality recompute, gc_coin_champions, validate_via_paper,
metrics.record, free-report buffers), the work functions of the loops (cache_gc._cleanup_once,
candle_store.cleanup / prefetch_top_coins, CacheWarmer._warm_one_cycle, trend_monitor.refresh /
load_state, signal_tracker.run_cycle, genome.evolve_generation, genome._proc_cpu_ratio = 5 s of
virtual time at 0 % CPU), ws_feed.run_ws_feed (2.5 s of "initial load", then one feed),
and the LEVELS / VOLUME scanners (other builder's modules): FakeMid.run_forever /
fake_run_volume_scanner — a cycle every 60 s with a heartbeat, crashing on the scripted
instants (restart backoff) and, for LEVELS, a heartbeat gap (Health Alert).

The gather list is bot.py's, in its order, restricted to the engine tasks the site ports
(services/engine/scheduler.js TASKS). Output: ../fixtures/scheduler_trace.json — the scenario,
the events [t, name, ...args] (t = virtual seconds since start), the admin alerts and the
INFO+ log records [t, logger, level, message].

Run (from the bot directory, env BOT_TOKEN_CHM=test:token ADMIN_IDS=123):
  PYTHONDONTWRITEBYTECODE=1 <venv311>/bin/python -u <this file>
"""
import ast
import asyncio
import gzip  # noqa: F401  (kept for symmetry with the other generators)
import html as _html
import json
import logging
import os
import selectors
import sys
import textwrap
import time
import types
from datetime import datetime as _RealDT, timezone

BOT_DIR = os.getcwd()
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "fixtures", "scheduler_trace.json")

T0 = 1791565200.0            # 2026-10-09 17:00:00 UTC — the 21:00 UTC report lands at 4 h
HORIZON = 6 * 3600.0
COINS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "XRP-USDT-SWAP"]
LEVELS_PERIOD = 60.0
VOLUME_PERIOD = 60.0
LEVELS_CRASHES = [1000.0, 1050.0, 1065.0, 3000.0]
LEVELS_HANG = [4000.0, 5200.0]          # no LEVELS heartbeat inside this window
VOLUME_CRASHES = [2000.0]
PAIRS_SCRIPT = {2: "empty", 3: "raise"}  # get_all_usdt_pairs call number → behaviour
GENOME_LAST_TS = T0 - 5 * 3600.0
WS_INITIAL_LOAD_S = 2.5

SCENARIO = {
    "t0": T0, "horizon": HORIZON, "coins": COINS,
    "levels_period": LEVELS_PERIOD, "volume_period": VOLUME_PERIOD,
    "levels_crashes": LEVELS_CRASHES, "levels_hang": LEVELS_HANG, "volume_crashes": VOLUME_CRASHES,
    "pairs_script": {str(k): v for k, v in PAIRS_SCRIPT.items()},
    "genome_last_ts": GENOME_LAST_TS, "ws_initial_load_s": WS_INITIAL_LOAD_S,
    "admin_ids": [123],
    "env": {"DATA_SOURCE": "bingx", "WS_FEED_MAX_SYMBOLS": "150"},
}

os.environ.update(SCENARIO["env"])
os.environ.pop("ENVIRONMENT", None)
try:
    from cryptography.fernet import Fernet
    os.environ["BYBIT_FERNET_KEY"] = Fernet.generate_key().decode()
except Exception:  # noqa: BLE001
    pass

# ── virtual-time event loop ──────────────────────────────────────────────────


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


_real_time = time.time
time.time = lambda: T0 + CLOCK.t
time.monotonic = lambda: CLOCK.t


class FakeDT(_RealDT):
    @classmethod
    def now(cls, tz=None):
        return _RealDT.fromtimestamp(T0 + CLOCK.t, tz) if tz else _RealDT.fromtimestamp(T0 + CLOCK.t)


def rel():
    return round(CLOCK.t, 6)


EVENTS = []
ALERTS = []
LOGS = []


def ev(name, *args):
    EVENTS.append([rel(), name, *args])


class Capture(logging.Handler):
    def emit(self, record):
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001
            msg = str(record.msg)
        if record.levelno >= logging.INFO:
            LOGS.append([rel(), record.name, record.levelname, msg])


root = logging.getLogger()
root.handlers[:] = []
root.addHandler(Capture())
root.setLevel(logging.DEBUG)

sys.path.insert(0, BOT_DIR)

# ── stubs installed before the bot modules import ────────────────────────────
_bt = types.ModuleType("backtest")


class _StubHistoryLoader:
    source = "stub"


_bt.HistoryLoader = _StubHistoryLoader
sys.modules["backtest"] = _bt

import config as _config_mod  # noqa: E402
from config import Config  # noqa: E402
import database  # noqa: E402
import cache  # noqa: E402
import cache_gc  # noqa: E402
import background_loops  # noqa: E402
import health_monitor  # noqa: E402
import coin_quality_learner  # noqa: E402
import momentum_detector  # noqa: E402
import genome  # noqa: E402
import genome_maintenance  # noqa: E402
import candle_store  # noqa: E402
import cache_warmer  # noqa: E402
import ws_feed  # noqa: E402
import free_report  # noqa: E402
import trend_monitor  # noqa: E402
import signal_tracker  # noqa: E402
import fetcher as fetcher_mod  # noqa: E402
import metrics  # noqa: E402
import metrics.recorder  # noqa: E402
from smc import scanner as smc_scanner  # noqa: E402

for _n in list(logging.Logger.manager.loggerDict):
    _lg = logging.getLogger(_n)
    if isinstance(_lg, logging.Logger):
        _lg.handlers[:] = []
        _lg.propagate = True
        _lg.disabled = False
        _lg.setLevel(logging.NOTSET)

# ── fakes ────────────────────────────────────────────────────────────────────
KV = {"genome_evolution_last_ts_v1": repr(GENOME_LAST_TS)}


async def fake_kv_get(key):
    return KV.get(key)


async def fake_kv_set(key, value):
    ev("kv.set", key, value)
    KV[key] = value


database.db_kv_get = fake_kv_get
database.db_kv_set = fake_kv_set


async def fake_ghost(max_age_days=3):
    ev("ghost.cleanup", max_age_days)
    return (0, 0)


database.db_cleanup_ghost_trades_all = fake_ghost


async def fake_export_subs_json():
    return None


database.export_subs_json = fake_export_subs_json


class _FakeCursor:
    rowcount = 0


class _FakeConn:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def execute(self, sql, params=()):
        if "DELETE FROM trades" in sql:
            ev("gc.trades")
        return _FakeCursor()

    async def commit(self):
        return None


_aio = types.ModuleType("aiosqlite")
_aio.connect = lambda *a, **k: _FakeConn()
sys.modules["aiosqlite"] = _aio


def fake_cleanup_once():
    ev("gc.cleanup")
    return {}


cache_gc._cleanup_once = fake_cleanup_once


async def fake_candle_cleanup(*a, **k):
    ev("gc.candles")


candle_store.cleanup = fake_candle_cleanup


async def fake_prefetch(loader, top_n=50, tfs=None, days=30):
    ev("prefetch")
    return {}


candle_store.prefetch_top_coins = fake_prefetch


async def fake_gc_champs():
    ev("genome.gc")
    return {"expired": 0, "lru_evicted": 0, "remaining": 0}


genome.gc_coin_champions = fake_gc_champs


async def fake_validate(genome_dict, strategy, tf, *a, **k):
    ev("genome.baseline", strategy, tf)
    return {"status": "NO_DATA"}


genome.validate_via_paper = fake_validate


async def fake_evolve(strategy, tf, *a, **k):
    ev("genome.evolve", strategy, tf)
    return {"generation": 1, "best_fitness": 0.5, "best_wr": 50.0, "best_pf": 1.5, "elapsed": 12.0}


genome.evolve_generation = fake_evolve


async def fake_cpu_ratio(window_s=5.0):
    await asyncio.sleep(window_s)
    return 0.0


genome._proc_cpu_ratio = fake_cpu_ratio


async def fake_restore_blacklist():
    return 0


async def fake_recompute():
    ev("coinq.recompute")
    coin_quality_learner._last_calc_ts = time.time()
    return {"total_pairs": 0, "blacklisted": 0, "expired": 0}


coin_quality_learner.restore_blacklist_from_kv = fake_restore_blacklist
coin_quality_learner.recompute_blacklist = fake_recompute


async def fake_metrics_record(*a, **k):
    return None


metrics.record = fake_metrics_record
metrics.recorder.record = fake_metrics_record


async def fake_load_state():
    return None


async def fake_refresh(bot, fetcher=None, *a, **k):
    ev("trend.refresh")
    return []


trend_monitor.load_state = fake_load_state
trend_monitor.refresh = fake_refresh


async def fake_run_cycle(bot, um, fetcher=None, *a, **k):
    ev("tracker.cycle")
    return 0


signal_tracker.run_cycle = fake_run_cycle


async def fake_load_buffers():
    return None


async def fake_save_buffer():
    return None


free_report.load_persistent_buffers = fake_load_buffers
free_report._save_missed_buffer = fake_save_buffer
free_report._save_closed_buffer = fake_save_buffer
free_report.datetime = FakeDT


async def fake_warm_one_cycle(self):
    ev("warmer.cycle")


cache_warmer.CacheWarmer._warm_one_cycle = fake_warm_one_cycle


async def fake_get_coins():
    return list(COINS)


cache.get_coins = fake_get_coins


class FakeFetcher:
    def __init__(self):
        self.vol_by_sym = {s: 10_000_000.0 for s in COINS}
        self._pairs_calls = 0

    async def get_all_usdt_pairs(self, min_volume_usdt=0, *a, **k):
        self._pairs_calls += 1
        ev("fetch.pairs", min_volume_usdt)
        mode = PAIRS_SCRIPT.get(self._pairs_calls)
        if mode == "empty":
            return []
        if mode == "raise":
            raise RuntimeError("pairs endpoint down")
        return list(COINS)

    async def get_candles(self, symbol, tf, limit=300, *a, **k):
        ev("fetch.candles", symbol, tf, limit)
        return None

    async def close(self):
        return None


FETCHER = FakeFetcher()
fetcher_mod.make_fetcher = lambda *a, **k: FETCHER
momentum_detector._data_source = lambda: "bingx"


class FakeUM:
    async def get_active_users(self, *a, **k):
        ev("um.active")
        return []

    async def all_users(self, *a, **k):
        ev("um.all")
        return []


UM = FakeUM()


class FakeBot:
    async def send_message(self, chat_id, text, parse_mode=None, **k):
        ALERTS.append([rel(), chat_id, text])
        ev("alert", chat_id, text)
        return types.SimpleNamespace(message_id=1)


BOT = FakeBot()
HEALTH = health_monitor.HealthMonitor(BOT, Config)


class FakeMid:
    """MidScanner stand-in: a cycle every LEVELS_PERIOD s, scripted crashes and a heartbeat gap."""

    def __init__(self, config, bot, um, stop_event=None):
        self.cfg = config
        self.bot = bot
        self.um = um
        self._stop_event = stop_event
        self.fetcher = FETCHER
        self._health = None
        self._crashes = list(LEVELS_CRASHES)
        self._n = 0

    async def run_forever(self):
        while True:
            t = rel()
            if not (LEVELS_HANG[0] <= t < LEVELS_HANG[1]) and self._health is not None:
                self._health.heartbeat("LEVELS")
            ev("levels.cycle")
            if self._crashes and t >= self._crashes[0]:
                self._crashes.pop(0)
                self._n += 1
                raise RuntimeError(f"levels boom #{self._n} <scan>")
            await asyncio.sleep(LEVELS_PERIOD)


_VOL_CRASHES = list(VOLUME_CRASHES)


async def fake_run_volume_scanner(bot, um, fetcher, health=None, interval_sec=60):
    while True:
        t = rel()
        if health is not None:
            health.heartbeat("VOLUME")
        ev("volume.cycle")
        if _VOL_CRASHES and t >= _VOL_CRASHES[0]:
            _VOL_CRASHES.pop(0)
            raise RuntimeError("volume boom")
        await asyncio.sleep(VOLUME_PERIOD)


class FakeFeed:
    _subscriptions = set()
    _loaded_channels = {}


async def fake_run_ws_feed(fetcher, symbols, timeframes):
    ev("ws.run", len(symbols), list(timeframes))
    await asyncio.sleep(WS_INITIAL_LOAD_S)
    ws_feed._active_feeds = [FakeFeed()]
    await asyncio.Event().wait()


ws_feed._active_feeds = []
ws_feed._active_feed = None

# ── bot.py main() nested functions, extracted verbatim ───────────────────────
NESTED = ["_guarded", "_guarded_restart", "_start_ws_feed", "_max_env_set", "_start_cache_warmer",
          "_coin_universe_warmup_loop", "_ghost_cleanup_loop", "_run_candle_prefetch"]
src = open(os.path.join(BOT_DIR, "bot.py"), encoding="utf-8").read()
tree = ast.parse(src)
main_fn = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "main")
ns = {
    "asyncio": asyncio, "log": logging.getLogger("CHM.Main"), "config": Config, "bot": BOT,
    "_html": _html, "time": time, "os": os, "cache": cache, "_run_ws_feed": fake_run_ws_feed,
    "database": database,
}
found = []


def _collect(node):
    for ch in ast.iter_child_nodes(node):
        if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)) and ch.name in NESTED:
            seg = ast.get_source_segment(src, ch)
            exec(compile(textwrap.dedent(seg), f"bot.py:{ch.name}", "exec"), ns)  # noqa: S102
            found.append(ch.name)
        elif not isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)):
            _collect(ch)


_collect(main_fn)
missing = set(NESTED) - set(found)
assert not missing, f"nested functions not found in bot.py main(): {missing}"
SOURCES = {name: textwrap.dedent(ast.get_source_segment(src, n)) for n in ast.walk(main_fn)
           if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and (name := n.name) in NESTED}

_guarded = ns["_guarded"]
_guarded_restart = ns["_guarded_restart"]


async def main():
    stop_event = asyncio.Event()
    scanner = FakeMid(Config, BOT, UM, stop_event=stop_event)
    scanner._health = HEALTH
    fetcher = scanner.fetcher
    coros = [
        _guarded_restart("scanner", lambda: scanner.run_forever()),
        _guarded("smc_coin_warmup", ns["_coin_universe_warmup_loop"](fetcher)),
        _guarded("cache_gc", cache_gc.gc_loop()),
        _guarded("genome_maintenance", genome_maintenance.run_genome_maintenance_loop()),
        _guarded("health_monitor", HEALTH.run_forever()),
        _guarded("coin_quality", coin_quality_learner.coin_quality_loop()),
        _guarded("regime_loop", background_loops.regime_loop(UM, fetcher)),
        _guarded("momentum_loop", momentum_detector.momentum_loop()),
        _guarded("ghost_cleanup", ns["_ghost_cleanup_loop"]()),
        _guarded("genome_evolution", genome.genome_evolution_loop()),
        _guarded("candle_prefetch", ns["_run_candle_prefetch"]()),
        _guarded("ws_feed", ns["_start_ws_feed"](fetcher)),
        _guarded("cache_warmer", ns["_start_cache_warmer"](fetcher)),
        _guarded_restart("smc_scanner", lambda: smc_scanner.run_smc_scanner(BOT, UM, fetcher, health=HEALTH), base_delay=30),
        _guarded_restart("volume_scanner", lambda: fake_run_volume_scanner(BOT, UM, fetcher, health=HEALTH)),
        _guarded("free_report", free_report.free_evening_report_loop(BOT, UM)),
        _guarded("trend_monitor", trend_monitor.trend_monitor_loop(BOT, UM, fetcher)),
        _guarded("signal_tracker", signal_tracker.signal_tracker_loop(BOT, UM, fetcher)),
    ]
    tasks = [asyncio.ensure_future(c) for c in coros]
    await asyncio.sleep(HORIZON)
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


loop = VirtualLoop()
asyncio.set_event_loop(loop)
loop.run_until_complete(main())
END_T = rel()

out = {
    "generator": "gen_scheduler_trace.py",
    "python": sys.version.split()[0],
    "scenario": SCENARIO,
    "end_t": END_T,
    "events": [e for e in EVENTS if e[0] <= HORIZON],
    "alerts": [a for a in ALERTS if a[0] <= HORIZON],
    "logs": [r for r in LOGS if r[0] < HORIZON],
    "nested_sources_sha": {k: __import__("hashlib").sha1(v.encode()).hexdigest() for k, v in sorted(SOURCES.items())},
    "constants": {
        "signal_tracker_interval_s": signal_tracker.INTERVAL_S,
        "trend_interval_s": trend_monitor.INTERVAL_S,
        "evolution_interval": genome.EVOLUTION_INTERVAL,
        "initial_delay": genome.INITIAL_DELAY,
        "gc_interval": cache_gc.GC_INTERVAL,
    },
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, indent=0, sort_keys=True)
print(f"events={len(out['events'])} alerts={len(out['alerts'])} logs={len(out['logs'])} end_t={END_T} -> {OUT}", flush=True)
sys.stdout.flush()
os._exit(0)
