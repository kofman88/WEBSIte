"""Deterministic replay harness around the bot's four traders.

Every scenario runs one bot trader coroutine with
  * a fake clock: time.time()/time.monotonic() only advance on time.sleep()/asyncio.sleep(),
    datetime.now() (pybit ErrTime, OKX ISO timestamp) follows the same clock;
  * scripted HTTP: pybit's `requests.Session.send` and each trader's aiohttp session are
    replaced by fakes that serve queued responses per (method, path) and RECORD every
    request (method, full URL, auth headers, body) exactly as the bot built it;
  * stubbed collaborators: killswitch / plan gate / metrics / trade_events / hedge-mode DB;
  * captured log records (to compare log markers).

Scenario dict (JSON-friendly, replayed 1:1 by the JS tests):
  name, exchange (bybit|bingx|binance|okx), call (bot function name), args, kwargs,
  routes: [{method, path, responses: [resp, ...]}]   (last response repeats)
  resp:   {status=200, json=..., text=..., headers={...}} | {raise: timeout|connect|error, message}
  mode:   'wire' (default; real pybit / real _request) | 'session' (Bybit only: fake pybit session
          object whose methods return the scripted dicts — the way the bot's own unit tests mock it)
  state:  {account_type: {key: "UNIFIED"}, hedge: {key: bool}, kv_hedge: bool|None,
           time_offset_ms: int, instrument_cache: {...}, ks_halted: str|None, plan_deny: dict|None,
           live_bingx: [...]}
  clock:  start time (default 1767225600.0); random: list of floats for random.random()
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import types
from datetime import datetime, timezone

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
sys.path.insert(0, BOT)
os.chdir(BOT)

import requests  # noqa: E402
import yarl  # noqa: E402
import aiohttp  # noqa: E402

import bybit_trader as by  # noqa: E402
import bingx_trader as bx  # noqa: E402
import binance_trader as bn  # noqa: E402
import okx_trader as ok  # noqa: E402
import api_retry  # noqa: E402
import exchange_breaker  # noqa: E402
import pybit._http_manager as pyhttp  # noqa: E402
import pybit._helpers as pyhelpers  # noqa: E402
import defense.killswitch as ks  # noqa: E402
import plan_gate  # noqa: E402
import metrics as metrics_mod  # noqa: E402
import db.trade_events as trade_events  # noqa: E402
import fetcher_bingx  # noqa: E402

import time as real_time  # noqa: E402
import asyncio as real_asyncio  # noqa: E402

_REAL_SLEEP = real_asyncio.sleep
logging.getLogger().addHandler(logging.NullHandler())  # keeps pybit from attaching its stderr handler
MARKER_RE = re.compile(r"\[[A-Z][A-Z0-9_-]*[A-Z0-9]\]")


class Clock:
    def __init__(self, start: float, mono: float = 1000.0, randoms=None):
        self.t = float(start)
        self.m = float(mono)
        self.sleeps: list[float] = []
        self.randoms = list(randoms or [])

    def time(self):
        return self.t

    def monotonic(self):
        return self.m

    def sleep(self, s):
        if s < 0:
            raise ValueError("sleep length must be non-negative")
        self.sleeps.append(s)
        self.t += s
        self.m += s

    async def asleep(self, s, *a, **k):
        self.sleep(s)
        await _REAL_SLEEP(0)

    def random(self):
        return self.randoms.pop(0) if self.randoms else 0.5


def _time_proxy(clock: Clock):
    ns = types.SimpleNamespace()
    for k in dir(real_time):
        if not k.startswith("__"):
            setattr(ns, k, getattr(real_time, k))
    ns.time = clock.time
    ns.monotonic = clock.monotonic
    ns.sleep = clock.sleep
    return ns


def _asyncio_proxy(clock: Clock):
    ns = types.SimpleNamespace()
    for k in dir(real_asyncio):
        if not k.startswith("__"):
            setattr(ns, k, getattr(real_asyncio, k))
    ns.sleep = clock.asleep
    return ns


def _dt_proxy(clock: Clock):
    class _DT(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.fromtimestamp(clock.t, tz or timezone.utc)
    return _DT


class _Random:
    def __init__(self, clock: Clock):
        self.clock = clock

    def uniform(self, a, b):
        return a + (b - a) * self.clock.random()

    def random(self):
        return self.clock.random()


# ── scripted HTTP ────────────────────────────────────────────────────────────

class Router:
    def __init__(self, routes):
        self.routes = [dict(r, responses=list(r["responses"])) for r in routes]
        self.log: list[dict] = []

    def take(self, method: str, url: str):
        path = yarl.URL(url).path
        for r in self.routes:
            if r["method"] == method and path == r["path"]:
                q = r.get("query")
                if q and q not in url:
                    continue
                if len(r["responses"]) > 1:
                    return r["responses"].pop(0)
                return r["responses"][0]
        return {"status": 404, "text": "no route", "headers": {"Content-Type": "text/plain"}}

    def record(self, method, url, headers, body):
        keep = {}
        for k, v in (headers or {}).items():
            kl = k.lower()
            if kl.startswith("x-bapi") or kl.startswith("x-bx") or kl.startswith("x-mbx") or kl.startswith("ok-access") or kl == "content-type" or kl == "x-simulated-trading":
                keep[k] = v
        self.log.append({"method": method, "url": url, "headers": keep, "body": body})


def _raise_for(spec, url):
    kind = spec["raise"]
    msg = spec.get("message", "")
    if kind == "timeout":
        raise asyncio.TimeoutError()
    if kind == "connect":
        class _CCE(aiohttp.ClientConnectorError):
            def __init__(self, m):
                Exception.__init__(self, m)
                self._m = m

            def __str__(self):
                return self._m
        raise _CCE(msg)
    raise aiohttp.ClientError(msg)


class FakeAioResponse:
    def __init__(self, spec, url, method):
        self.spec = spec
        self.status = spec.get("status", 200)
        self.url = url
        self.method = method
        hdrs = {"Content-Type": "application/json"}
        hdrs.update(spec.get("headers") or {})
        self.headers = hdrs
        if "json" in spec:
            self._text = json.dumps(spec["json"])
        else:
            self._text = spec.get("text", "")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def text(self):
        return self._text

    async def json(self, content_type="application/json", **k):
        if content_type:
            ctype = ""
            for hk, hv in self.headers.items():
                if hk.lower() == "content-type":
                    ctype = hv.lower()
            if not re.match(r"^application/(?:[\w.+-]+?\+)?json", ctype):
                from multidict import CIMultiDict, CIMultiDictProxy
                ri = aiohttp.RequestInfo(url=yarl.URL(self.url), method=self.method,
                                         headers=CIMultiDictProxy(CIMultiDict()), real_url=yarl.URL(self.url))
                raise aiohttp.ContentTypeError(ri, (), status=self.status,
                                               message="Attempt to decode JSON with unexpected mimetype: %s" % ctype)
        stripped = self._text.strip()
        if not stripped:
            return None
        return json.loads(stripped)


class FakeAioSession:
    closed = False

    def __init__(self, router: Router):
        self.router = router

    def _do(self, method, url, headers=None, params=None, data=None, **k):
        u = yarl.URL(str(url), encoded=True) if not isinstance(url, yarl.URL) else url
        if params:
            u = u.update_query(params)
        full = str(u)
        body = data if isinstance(data, str) else (data.decode() if isinstance(data, bytes) else None)
        self.router.record(method, full, headers, body)
        spec = self.router.take(method, full)
        if "raise" in spec:
            _raise_for(spec, full)
        return FakeAioResponse(spec, full, method)

    def get(self, url, **k):
        return self._do("GET", url, **k)

    def post(self, url, **k):
        return self._do("POST", url, **k)

    def delete(self, url, **k):
        return self._do("DELETE", url, **k)

    async def close(self):
        pass


def install_requests_fake(router: Router):
    def _send(self, request, **kwargs):
        body = request.body
        if isinstance(body, bytes):
            body = body.decode()
        router.record(request.method, request.url, dict(request.headers), body)
        spec = router.take(request.method, request.url)
        if "raise" in spec:
            msg = spec.get("message", "")
            if spec["raise"] == "timeout":
                raise requests.exceptions.ReadTimeout(msg)
            raise requests.exceptions.ConnectionError(msg)
        resp = requests.models.Response()
        resp.status_code = spec.get("status", 200)
        hdrs = {"Content-Type": "application/json"}
        hdrs.update(spec.get("headers") or {})
        resp.headers = requests.structures.CaseInsensitiveDict(hdrs)
        resp._content = (json.dumps(spec["json"]) if "json" in spec else spec.get("text", "")).encode()
        resp.encoding = "utf-8"
        resp.url = request.url
        resp.request = request
        import datetime as _d
        resp.elapsed = _d.timedelta(0)
        return resp
    requests.Session.send = _send


class FakeSession:
    """pybit HTTP stand-in returning scripted dicts (mode='session')."""

    def __init__(self, router: Router, demo=False):
        self.router = router
        self.endpoint = "https://api-demo.bybit.com" if demo else "https://api.bybit.com"
        self.time_offset = 0

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        def _call(**kwargs):
            self.router.log.append({"method": name, "kwargs": kwargs})
            spec = self.router.take("CALL", "https://x/" + name)
            if "raise" in spec:
                from pybit import exceptions as pe
                if spec["raise"] == "invalid":
                    raise pe.InvalidRequestError(request=f"call {name}", message=spec.get("message", ""),
                                                 status_code=spec.get("code", -1), time="00:00:00", resp_headers=None)
                raise Exception(spec.get("message", ""))
            return json.loads(spec["text"]) if "text" in spec else spec["json"]
        return _call


# ── per-scenario setup ───────────────────────────────────────────────────────

class LogCapture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.records = []

    def emit(self, record):
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001
            msg = str(record.msg)
        self.records.append((record.levelname, msg))


def reset_state(clock: Clock):
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
    ok._okx_time_offset_ms = 0
    exchange_breaker.breaker._states.clear()
    fetcher_bingx._LIVE = set()


def run_scenario(sc: dict) -> dict:
    clock = Clock(sc.get("clock", 1767225600.0), randoms=sc.get("random"))
    router = Router(sc.get("routes", []))
    reset_state(clock)
    tp = _time_proxy(clock)
    ap = _asyncio_proxy(clock)
    for mod in (by, bx, bn, ok):
        mod.time = tp
        mod.asyncio = ap
    api_retry.asyncio = ap
    api_retry.random = _Random(clock)
    exchange_breaker.time = tp
    pyhttp.time = tp
    pyhelpers.time = tp
    pyhttp.dt = _dt_proxy(clock)
    ok.datetime = _dt_proxy(clock)
    by._api_bucket = by._TokenBucket(rate=10.0, burst=15)
    by._async_api_bucket = by._AsyncTokenBucket(rate=10.0, burst=15)
    fake = FakeAioSession(router)

    async def _gs():
        return fake
    for mod in (by, bx, bn, ok):
        mod._get_http_session = _gs

    async def _reset():
        return None
    by._reset_http_session = _reset
    install_requests_fake(router)
    state = sc.get("state", {})
    if sc.get("mode") == "session":
        by._get_session = lambda api_key, api_secret, demo=False: FakeSession(router, demo)
    else:
        by._get_session = _ORIG_GET_SESSION
    for k, v in (state.get("account_type") or {}).items():
        by._account_type_cache[k] = v
    for k, v in (state.get("hedge") or {}).items():
        by._hedge_cache_set(k, v)
    if "time_offset_ms" in state:
        by._bybit_time_offset_ms = state["time_offset_ms"]
        by._bybit_time_synced_at = clock.t
    if "bingx_offset_ms" in state:
        bx._bingx_time_offset_ms = state["bingx_offset_ms"]
    if "binance_offset_ms" in state:
        bn._binance_time_offset_ms = state["binance_offset_ms"]
    if "okx_offset_ms" in state:
        ok._okx_time_offset_ms = state["okx_offset_ms"]
    if state.get("live_bingx"):
        fetcher_bingx._LIVE = set(state["live_bingx"])
    saved = {"hedge_saved": [], "auth_reset": [], "events": [], "metrics": []}

    class _DB:
        async def db_get_hedge_mode(self, api_key):
            return state.get("kv_hedge")

        async def db_save_hedge_mode(self, api_key, is_hedge):
            saved["hedge_saved"].append(bool(is_hedge))

        async def db_find_user_ids_by_api_key(self, exchange, api_key):
            return state.get("auth_uids", [])

        async def db_set_auto_trade(self, uid, enabled):
            saved["auth_reset"].append([uid, enabled])
    by.db = _DB()

    async def _ks(context=""):
        if state.get("ks_halted"):
            raise ks.KillswitchHalted(state["ks_halted"], "test", context)
    ks.require_active = _ks

    async def _deny(user_id, symbol, source):
        return state.get("plan_deny")
    plan_gate.deny_reason = _deny

    async def _rec(name, value=1.0, tags=None):
        saved["metrics"].append(name)
    metrics_mod.record = _rec
    trade_events.emit_bg = lambda tid, evt, payload=None: saved["events"].append([tid, evt])

    cap = LogCapture()
    loggers = [logging.getLogger(n) for n in ("CHM.Bybit", "CHM.BingX", "CHM.Binance", "CHM.OKX.Trader", "CHM.ApiRetry", "CHM.ExchangeBreaker")]
    for lg in loggers:
        lg.addHandler(cap)
        lg.setLevel(logging.DEBUG)
        lg.propagate = False
    mod = {"bybit": by, "bingx": bx, "binance": bn, "okx": ok}[sc["exchange"]]
    fn = getattr(mod, sc["call"])
    out = {"name": sc["name"]}
    # functions that do `import time as _time` locally (bybit dashboard / summary) get the proxy too
    sys.modules["time"] = tp
    try:
        res = fn(*sc.get("args", []), **sc.get("kwargs", {}))
        if asyncio.iscoroutine(res):
            res = asyncio.run(res)
        out["result"] = _jsonable(res)
    except Exception as e:  # noqa: BLE001
        out["raised"] = {"type": type(e).__name__, "msg": str(e)}
    finally:
        sys.modules["time"] = real_time
        for lg in loggers:
            lg.removeHandler(cap)
    out["requests"] = router.log
    out["sleeps"] = clock.sleeps
    out["clock_end"] = clock.t
    out["markers"] = [[lvl, m] for lvl, msg in cap.records for m in MARKER_RE.findall(msg)]
    out["saved"] = saved
    out["final"] = {
        "hedge": {k: v for k, v in by._hedge_mode_cache.items()},
        "account_type": dict(by._account_type_cache),
        "delisted": sorted(by._delisted_symbols.keys()),
        "fail_count": dict(by._symbol_fail_count),
        "bybit_offset": by._bybit_time_offset_ms,
    }
    return out


_ORIG_GET_SESSION = by._get_session


def _jsonable(o):
    if isinstance(o, tuple):
        return [_jsonable(x) for x in o]
    if isinstance(o, list):
        return [_jsonable(x) for x in o]
    if isinstance(o, dict):
        return {str(k): _jsonable(v) for k, v in o.items()}
    if isinstance(o, float):
        if o != o:
            return {"__float__": "nan"}
        if o in (float("inf"), float("-inf")):
            return {"__float__": "inf" if o > 0 else "-inf"}
    return o
