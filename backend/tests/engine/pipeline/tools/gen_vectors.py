"""gen_vectors.py — Python-computed vectors for the M9a pipeline modules.

Every vector is produced by the bot's own code (read-only import from the checkout):

  cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \
    <venv>/bin/python <site>/backend/tests/engine/pipeline/tools/gen_vectors.py [section ...]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json

Writes fixtures/<section>.json. Clocks are faked (module `time` replaced), kv / db /
Telegram are in-memory fakes, so the scripts are deterministic. Non-finite floats are
encoded as {"$f": "nan" | "inf" | "-inf"}.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import random
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "..", "fixtures")
sys.path.insert(0, os.getcwd())

import database  # noqa: E402


# ── helpers ────────────────────────────────────────────────────────────────
def enc(x):
    if isinstance(x, float) and not math.isfinite(x):
        return {"$f": "nan" if math.isnan(x) else ("inf" if x > 0 else "-inf")}
    if isinstance(x, dict):
        return {str(k): enc(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [enc(v) for v in x]
    return x


def write(name, doc):
    with open(os.path.join(FIX, f"{name}.json"), "w", encoding="utf-8") as fh:
        json.dump(enc(doc), fh, ensure_ascii=False, indent=1, allow_nan=False)
        fh.write("\n")
    print(name, "ok")


class Clock:
    def __init__(self, t):
        self.t = float(t)

    def time(self):
        return self.t

    def gmtime(self, *a):
        import time as _t
        return _t.gmtime(*a)


class Capture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.lines = []

    def emit(self, record):
        self.lines.append([record.levelname, record.getMessage()])


def capture(logger_name):
    cap = Capture()
    lg = logging.getLogger(logger_name)
    lg.setLevel(logging.DEBUG)
    lg.addHandler(cap)
    lg.propagate = False
    return cap


class FakeKV:
    def __init__(self):
        self.d = {}
        self.writes = []

    async def get(self, k):
        return self.d.get(k)

    async def set(self, k, v):
        self.d[k] = v
        self.writes.append([k, v])

    async def delete(self, k):
        self.d.pop(k, None)

    async def keys_with_prefix(self, p):
        return [k for k in self.d if k.startswith(p)]


def install_kv(kv):
    database.db_kv_get = kv.get
    database.db_kv_set = kv.set
    database.db_kv_delete = kv.delete
    database.db_kv_keys_with_prefix = kv.keys_with_prefix


def frame_rows(df):
    return [[float(df["open"].iloc[i]), float(df["high"].iloc[i]), float(df["low"].iloc[i]),
             float(df["close"].iloc[i]), float(df["volume"].iloc[i])] for i in range(len(df))]


def make_df(rows, start_ms=1_700_000_000_000, step_ms=900_000):
    import pandas as pd
    idx = pd.to_datetime([start_ms + i * step_ms for i in range(len(rows))], unit="ms")
    return pd.DataFrame(rows, columns=["open", "high", "low", "close", "volume"], index=idx)


def walk(n, seed, start=100.0, vol=0.01, drift=0.0, vol_base=1000.0):
    rnd = random.Random(seed)
    rows = []
    p = start
    for _ in range(n):
        o = p
        c = o * (1 + drift + rnd.gauss(0, vol))
        h = max(o, c) * (1 + abs(rnd.gauss(0, vol / 2)))
        lo = min(o, c) * (1 - abs(rnd.gauss(0, vol / 2)))
        v = vol_base * (0.5 + rnd.random())
        rows.append([o, h, lo, c, v])
        p = c
    return rows


# ── registry ───────────────────────────────────────────────────────────────
def registry_vectors():
    import signal_registry as sr
    clk = Clock(1_800_000_000.25)
    sr.time = clk
    tmp = tempfile.mkdtemp()
    path = os.path.join(tmp, "reg.json")
    sr._PERSIST_PATH = path
    cap = capture("CHM.SignalRegistry")

    def reset():
        sr._registry.clear()
        sr._stats.update(allowed=0, blocked=0)
        sr._last_cleanup = 0.0
        sr._last_persist = 0.0
        if os.path.exists(path):
            os.remove(path)
        cap.lines.clear()

    def snap():
        return {"|".join(str(p) for p in k): v for k, v in sr._registry.items()}

    def persisted():
        if not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as fh:
            return fh.read()

    users = {
        "multi": dict(user_id=555, strategy="LEVELS", extra_strategies="SMC", sub_plan="pro"),
        "single": dict(user_id=556, strategy="SMC", extra_strategies="", sub_plan="pro"),
        "free_extras": dict(user_id=557, strategy="LEVELS", extra_strategies="SMC,VOLUME", sub_plan="free"),
        "admin": dict(user_id=123, strategy="LEVELS", extra_strategies="VOLUME", sub_plan="free"),
        "vol_pro": dict(user_id=558, strategy="VOLUME", extra_strategies="LEVELS", sub_plan="pro"),
    }

    def U(name):
        return types.SimpleNamespace(**users[name])

    scripts = {
        "basic": [
            ["peek", 1, "BTC-USDT-SWAP", "LONG", ""],
            ["commit", 1, "BTC-USDT-SWAP", "LONG", "", None],
            ["peek", 1, "BTC-USDT-SWAP", "LONG", ""],
            ["peek", 1, "BTC-USDT-SWAP", "LONG", "SMC"],
            ["advance", 5],
            ["commit", 1, "BTC-USDT-SWAP", "LONG", "SMC", None],
            ["advance", 14399.0],
            ["peek", 1, "BTC-USDT-SWAP", "LONG", ""],
            ["advance", 1.0],
            ["peek", 1, "BTC-USDT-SWAP", "LONG", ""],
            ["peek", 1, "BTC-USDT-SWAP", "LONG", "SMC"],
            ["advance", 6.0],
            ["peek", 1, "BTC-USDT-SWAP", "LONG", "SMC"],
            ["stats"],
        ],
        "ttl_shift": [
            ["commit", 7, "ETH-USDT-SWAP", "SHORT", "VOLUME", 3600],
            ["advance", 3599.5],
            ["peek", 7, "ETH-USDT-SWAP", "SHORT", "VOLUME"],
            ["advance", 0.5],
            ["peek", 7, "ETH-USDT-SWAP", "SHORT", "VOLUME"],
            ["commit", 7, "ETH-USDT-SWAP", "SHORT", "VOLUME", 30],
            ["peek", 7, "ETH-USDT-SWAP", "SHORT", "VOLUME"],
            ["advance", 59.9],
            ["peek", 7, "ETH-USDT-SWAP", "SHORT", "VOLUME"],
            ["advance", 0.2],
            ["peek", 7, "ETH-USDT-SWAP", "SHORT", "VOLUME"],
            ["commit", 7, "ETH-USDT-SWAP", "SHORT", "VOLUME", 57600.9],
            ["advance", 57600.0],
            ["peek", 7, "ETH-USDT-SWAP", "SHORT", "VOLUME"],
            ["advance", 0.5],
            ["peek", 7, "ETH-USDT-SWAP", "SHORT", "VOLUME"],
            ["commit", 7, "SOL-USDT-SWAP", "LONG", "", 14400],
            ["commit", 7, "XRP-USDT-SWAP", "LONG", "", 100000],
            ["stats"],
        ],
        "multi": [
            ["peek_multi", "multi", "BTC-USDT-SWAP", "LONG"],
            ["claim_multi", "multi", "BTC-USDT-SWAP", "LONG", 120],
            ["peek_multi", "multi", "BTC-USDT-SWAP", "LONG"],
            ["advance", 121],
            ["peek_multi", "multi", "BTC-USDT-SWAP", "LONG"],
            ["claim_multi", "multi", "BTC-USDT-SWAP", "LONG", 120],
            ["commit_multi", "multi", "BTC-USDT-SWAP", "LONG"],
            ["advance", 7200],
            ["peek_multi", "multi", "BTC-USDT-SWAP", "LONG"],
            ["peek_multi", "single", "BTC-USDT-SWAP", "LONG"],
            ["claim_multi", "single", "BTC-USDT-SWAP", "LONG", 120],
            ["commit_multi", "single", "BTC-USDT-SWAP", "LONG"],
            ["peek_multi", "free_extras", "BTC-USDT-SWAP", "LONG"],
            ["claim_multi", "free_extras", "BTC-USDT-SWAP", "LONG", 120],
            ["claim_multi", "admin", "ETH-USDT-SWAP", "SHORT", 120],
            ["peek_multi", "admin", "ETH-USDT-SWAP", "SHORT"],
            ["can_send_multi", "vol_pro", "ETH-USDT-SWAP", "SHORT"],
            ["can_send_multi", "vol_pro", "ETH-USDT-SWAP", "SHORT"],
            ["can_send", 9, "ADA-USDT-SWAP", "LONG", ""],
            ["can_send", 9, "ADA-USDT-SWAP", "LONG", ""],
            ["stats"],
        ],
        "cooldown": [
            ["commit", 3, "PEPE-USDT-SWAP", "LONG", "", None],
            ["commit", 3, "PEPE-USDT-SWAP", "LONG", "SMC", None],
            ["commit", 3, "PEPE-USDT-SWAP", "LONG", "MULTI", None],
            ["commit", 3, "PEPE-USDT-SWAP", "SHORT", "SMC", None],
            ["commit", 4, "PEPE-USDT-SWAP", "LONG", "SMC", None],
            ["advance", 600],
            ["cooldown", 3, "PEPE-USDT-SWAP", "LONG", 1800],
            ["peek", 3, "PEPE-USDT-SWAP", "LONG", ""],
            ["peek", 3, "PEPE-USDT-SWAP", "LONG", "SMC"],
            ["advance", 1799.5],
            ["peek", 3, "PEPE-USDT-SWAP", "LONG", "SMC"],
            ["advance", 1.0],
            ["peek", 3, "PEPE-USDT-SWAP", "LONG", "SMC"],
            ["peek", 3, "PEPE-USDT-SWAP", "SHORT", "SMC"],
            ["peek", 4, "PEPE-USDT-SWAP", "LONG", "SMC"],
            ["cooldown", 5, "DOGE-USDT-SWAP", "SHORT", 30],
            ["peek", 5, "DOGE-USDT-SWAP", "SHORT", ""],
            ["advance", 59],
            ["peek", 5, "DOGE-USDT-SWAP", "SHORT", ""],
            ["advance", 1.5],
            ["peek", 5, "DOGE-USDT-SWAP", "SHORT", ""],
            ["cooldown", 6, "WIF-USDT-SWAP", "LONG", 99999],
            ["cooldown", 6, "WIF-USDT-SWAP", "SHORT", 90.5],
            ["clear", 3, "PEPE-USDT-SWAP", "LONG"],
            ["clear", 3, "NONE-USDT-SWAP", "LONG"],
            ["advance", 20000],
            ["commit", 8, "LINK-USDT-SWAP", "LONG", "", None],
            ["stats"],
            ["force_save"],
        ],
    }

    out_scripts = {}
    for name, ops in scripts.items():
        reset()
        clk.t = 1_800_000_000.25
        steps = []
        for op in ops:
            kind = op[0]
            res = None
            if kind == "advance":
                clk.t += op[1]
            elif kind == "peek":
                res = sr.peek_can_send(op[1], op[2], op[3], op[4])
            elif kind == "commit":
                sr.commit_send(op[1], op[2], op[3], op[4], ttl_s=op[5])
            elif kind == "can_send":
                res = sr.can_send(op[1], op[2], op[3], op[4])
            elif kind == "peek_multi":
                res = sr.peek_can_send_multi(U(op[1]), op[2], op[3])
            elif kind == "claim_multi":
                sr.claim_multi(U(op[1]), op[2], op[3], ttl_s=op[4])
            elif kind == "commit_multi":
                sr.commit_send_multi(U(op[1]), op[2], op[3])
            elif kind == "can_send_multi":
                res = sr.can_send_multi(U(op[1]), op[2], op[3])
            elif kind == "cooldown":
                sr.apply_cooldown(op[1], op[2], op[3], cooldown_s=op[4])
            elif kind == "clear":
                sr.clear_for_symbol(op[1], op[2], op[3])
            elif kind == "stats":
                res = sr.get_stats()
            elif kind == "force_save":
                res = sr.force_save()
            steps.append({"op": op, "now": clk.t, "result": res, "registry": snap(), "persisted": persisted(),
                          "logs": [l for l in cap.lines if l[0] in ("INFO", "WARNING")]})
            cap.lines.clear()
        out_scripts[name] = steps

    # _persist_load table
    now0 = 1_800_000_000.0
    loads = [
        json.dumps({"1|BTC-USDT-SWAP|LONG": now0 - 100, "2|ETH-USDT-SWAP|SHORT|SMC": now0 - 14399.5,
                    "3|X-USDT-SWAP|LONG|VOLUME": now0 - 14400.0, "4|Y-USDT-SWAP|LONG|MULTI": now0 + 500.5,
                    "abc|Z-USDT-SWAP|LONG": now0, "5|onlytwo": now0, "007|Q-USDT-SWAP|SHORT": now0 - 1}),
        json.dumps({"1|A-USDT-SWAP|LONG": "1799999999.5", "2|B-USDT-SWAP|LONG": True}),
        json.dumps({"1|A-USDT-SWAP|LONG": now0, "2|B-USDT-SWAP|LONG": None, "3|C-USDT-SWAP|LONG": now0}),
        json.dumps({"1|A-USDT-SWAP|LONG": now0, "2|B-USDT-SWAP|LONG": "soon"}),
        json.dumps([1, 2, 3]),
        "{not json",
        json.dumps({" 12 |A-USDT-SWAP|LONG": now0 - 5, "+13|B-USDT-SWAP|LONG|SMC|extra": now0 - 5, "1_4|C|LONG": now0}),
        json.dumps({}),
    ]
    load_cases = []
    for raw in loads:
        reset()
        clk.t = now0
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(raw)
        sr._persist_load()
        load_cases.append({"raw": raw, "now": now0, "registry": snap(),
                           "logs": [l for l in cap.lines if l[0] in ("INFO", "WARNING")]})
    cap.lines.clear()
    write("registry", {
        "constants": {"CROSS_TTL": sr.CROSS_TTL, "CLAIM_TTL_S": sr.CLAIM_TTL_S, "_CLEANUP_INTERVAL": sr._CLEANUP_INTERVAL,
                      "_PERSIST_INTERVAL": sr._PERSIST_INTERVAL, "_STRATEGY_TTL": sr._STRATEGY_TTL},
        "users": users, "scripts": out_scripts, "loads": load_cases,
        # scanner_mid: int(os.getenv("POST_CLOSE_COOLDOWN_SEC", "1800")) — "raise" = ValueError in the bot
        "env_cooldown": [[v, 1800 if v is None else (int(v) if _int_ok(v) else "raise")]
                         for v in [None, "1800", " 600 ", "abc", "", "-5", "1_200", "3600.0"]],
    })


def _int_ok(v):
    if v is None:
        return True
    try:
        int(v)
        return True
    except ValueError:
        return False


# ── freshness ──────────────────────────────────────────────────────────────
def freshness_vectors():
    import signal_freshness as sf
    cap = capture("CHM.SignalFreshness")
    tol = []
    envs = [
        {},
        {"FRESHNESS_BASELINE_S": "10", "FRESHNESS_TOLERANCE_STEP_PCT": "0.01", "FRESHNESS_TOLERANCE_MAX_PCT": "0.002"},
        {"FRESHNESS_BASELINE_S": "", "FRESHNESS_TOLERANCE_STEP_PCT": "abc", "FRESHNESS_TOLERANCE_MAX_PCT": " 0.004 "},
        {"FRESHNESS_TOLERANCE_MAX_PCT": "inf", "FRESHNESS_BASELINE_S": "1_0"},
    ]
    keys = ["FRESHNESS_BASELINE_S", "FRESHNESS_TOLERANCE_STEP_PCT", "FRESHNESS_TOLERANCE_MAX_PCT"]
    for env in envs:
        for k in keys:
            os.environ.pop(k, None)
        os.environ.update(env)
        for ema in [0.0, 29.9, 30.0, 30.5, 45.0, 100.0, 130.0, 529.9, 530.0, 1000.0, 1e6, -5.0]:
            tol.append({"env": env, "ema": ema, "tol": sf.compute_tolerance_pct(ema)})
    for k in keys:
        os.environ.pop(k, None)

    # EMA sequences
    sf.reset_cycle_ema_for_tests()
    ema_steps = []
    for strat, sec in [("levels", 40.0), ("LEVELS", 100.0), ("smc", 10), ("SMC", 0), ("", 50), ("VOLUME", -3), ("LEVELS", 61.5),
                       ("volume", 12.25), ("LeVeLs", 7.0)]:
        sf.report_cycle_time(strat, sec)
        ema_steps.append({"strategy": strat, "seconds": sec,
                          "ema": {s: sf.get_cycle_ema(s) for s in ["LEVELS", "levels", "SMC", "VOLUME", "", "OTHER"]}})

    # is_signal_fresh table
    cases = []
    sf.reset_cycle_ema_for_tests()
    base = [
        dict(direction="LONG", entry=100.0, tp1=104.0, sl=98.0),
        dict(direction="SHORT", entry=100.0, tp1=96.0, sl=102.0),
    ]
    currents = [None, 95.0, 97.9, 98.0, 98.9, 99.0, 100.0, 100.99, 101.0, 101.01, 102.0, 103.0, 104.0, 104.3, 104.6, 96.0, 95.7]
    emas = [0.0, 130.0, 1000.0]
    for ema in emas:
        sf.reset_cycle_ema_for_tests()
        if ema:
            sf.report_cycle_time("LEVELS", ema)
        for b in base:
            for cur in currents:
                for sl in (b["sl"], 0.0):
                    async def price(_s, cur=cur):
                        return cur
                    sf.get_current_price = price
                    cap.lines.clear()
                    res = asyncio.run(sf.is_signal_fresh(symbol="TEST-USDT-SWAP", direction=b["direction"], entry=b["entry"],
                                                         tp1=b["tp1"], strategy="LEVELS", uid=42, sl=sl))
                    cases.append({"ema": ema, "symbol": "TEST-USDT-SWAP", "strategy": "LEVELS", "uid": 42,
                                  "direction": b["direction"], "entry": b["entry"], "tp1": b["tp1"], "sl": sl,
                                  "current": cur, "fresh": res, "logs": [l[1] for l in cap.lines]})
    # malformed / odd
    for kw in [dict(entry=0.0, tp1=1.0), dict(entry=1.0, tp1=0.0), dict(entry=-1.0, tp1=1.0), dict(entry=1.0, tp1=-2.0)]:
        async def price(_s):
            return 5.0
        sf.get_current_price = price
        res = asyncio.run(sf.is_signal_fresh(symbol="X", direction="LONG", strategy="", uid=0, sl=0.0, **kw))
        cases.append({"ema": 0.0, "symbol": "X", "strategy": "", "uid": 0, "direction": "LONG", "sl": 0.0,
                      "current": 5.0, "fresh": res, "logs": [], **kw})
    for d in ["long", "", "BOTH"]:
        async def price(_s):
            return 200.0
        sf.get_current_price = price
        cap.lines.clear()
        res = asyncio.run(sf.is_signal_fresh(symbol="X", direction=d, entry=100.0, tp1=104.0, strategy="SMC", uid=1, sl=98.0))
        cases.append({"ema": 0.0, "symbol": "X", "direction": d, "entry": 100.0, "tp1": 104.0, "sl": 98.0, "current": 200.0,
                      "fresh": res, "logs": [l[1] for l in cap.lines], "strategy": "SMC", "uid": 1})
    write("freshness", {"tolerance": tol, "ema_steps": ema_steps, "fresh": cases, "MAX_DRIFT_R": sf.MAX_DRIFT_R})


# ── momentum veto + detector ───────────────────────────────────────────────
def momentum_vectors():
    import importlib
    import momentum_veto as mv
    frames = []
    for seed in range(8):
        rows = walk(60, seed, start=50.0 + seed * 7, vol=0.004 + 0.002 * (seed % 3))
        frames.append(rows)
    # injected spikes against LONG / SHORT
    for seed, mult, vmul in [(11, -0.02, 3.0), (12, 0.02, 3.0), (13, -0.03, 1.0), (14, 0.03, 1.0), (15, -0.006, 2.0),
                             (16, 0.004, 1.6), (17, -0.0001, 5.0), (18, 0.0, 1.0)]:
        rows = walk(40, seed, start=20.0, vol=0.003)
        for k in range(3):
            o = rows[-1][3]
            c = o * (1 + mult)
            rows.append([o, max(o, c) * 1.001, min(o, c) * 0.999, c, rows[-1][4] * vmul])
        frames.append(rows)
    frames.append(walk(18, 99))           # insufficient (19 needed)
    frames.append(walk(19, 98))
    flat = [[10.0, 10.0, 10.0, 10.0, 100.0] for _ in range(30)]
    frames.append(flat)
    zero_vol = [[r[0], r[1], r[2], r[3], 0.0] for r in walk(30, 97)]
    frames.append(zero_vol)
    neg_price = walk(30, 96)
    neg_price[-4][3] = 0.0
    frames.append(neg_price)
    nan_row = walk(30, 95)
    nan_row[-5][1] = float("nan")
    frames.append(nan_row)

    envs = [{}, {"MOMENTUM_VETO_ATR_MULT": "0.3", "MOMENTUM_VETO_VOL_MULT": "1.1", "MOMENTUM_VETO_LOOKBACK": "5"},
            {"MOMENTUM_VETO_ENABLED": "off"}, {"MOMENTUM_VETO_ENABLED": "YES", "MOMENTUM_VETO_LOOKBACK": "0.8",
                                                "MOMENTUM_VETO_ATR_MULT": " 1_0 "},
            {"MOMENTUM_VETO_LOOKBACK": "0"}, {"MOMENTUM_VETO_ATR_MULT": "nan"}]
    keys = ["MOMENTUM_VETO_ENABLED", "MOMENTUM_VETO_ATR_MULT", "MOMENTUM_VETO_VOL_MULT", "MOMENTUM_VETO_LOOKBACK"]
    veto = []
    for env in envs:
        for k in keys:
            os.environ.pop(k, None)
        os.environ.update(env)
        mod = importlib.reload(mv)
        consts = {"ENABLED": mod._ENABLED, "ATR": mod._DEFAULT_ATR_MULT, "VOL": mod._DEFAULT_VOL_MULT, "LB": mod._DEFAULT_LOOKBACK}
        res = []
        for fi, rows in enumerate(frames):
            df = make_df(rows)
            for d in ("LONG", "SHORT", "BOTH"):
                res.append([fi, d, list(mod.is_momentum_veto(df, d)), mod._compute_atr_pct(df)])
        res.append([-1, "LONG", list(mod.is_momentum_veto(None, "LONG")), 0.0])
        veto.append({"env": env, "consts": consts, "results": res})
    for k in keys:
        os.environ.pop(k, None)
    importlib.reload(mv)

    # detector
    import momentum_detector as md
    clk = Clock(1_800_000_000.0)
    md.time = clk
    det = {"relax": [], "macro": [], "breakout": []}
    md._state.relaxed = False
    for orig in [5, 3, 2, 1, 0]:
        det["relax"].append([orig, md.relax_min_quality(orig), md.relax_min_rr(float(orig)), md.relax_confirmations(orig), md.relax_min_rr(2.2)])
    oc_cases = [
        ((100.0, 102.0), (100.0, 100.5)),
        ((100.0, 101.99), (100.0, 97.9)),
        ((100.0, 97.5), (100.0, 103.0)),
        ((0.0, 5.0), (10.0, 10.1)),
        ((100.0, 100.0), (0.0, 1.0)),
        None,
    ]
    for oc in oc_cases:
        md._state.relaxed = False
        md._state.relaxed_until = 0.0
        md._state.trigger_reason = ""

        async def fake(oc=oc):
            return oc
        md._data_source = lambda: "bingx"
        md._last_closed_1h_via_fetcher = fake
        reason = asyncio.run(md.check_macro_momentum())
        st = md.get_state()
        det["macro"].append({"oc": oc, "reason": reason, "state": dict(relaxed=st.relaxed, relaxed_until=st.relaxed_until,
                                                                       trigger_symbol=st.trigger_symbol, trigger_reason=st.trigger_reason,
                                                                       btc=st.btc_1h_change, eth=st.eth_1h_change),
                             "relaxed_now": md.is_relaxed_mode()})
    # expiry
    md._state.relaxed = True
    md._state.relaxed_until = clk.t + 1800
    exp = []
    for dt in [0, 1800, 1800.5]:
        clk.t = 1_800_000_000.0 + dt
        exp.append([dt, md.is_relaxed_mode(), md.relax_min_quality(4)])
    det["expiry"] = exp
    # ATR breakout on synthetic frames
    md._last_breakout_alert.clear()
    clk.t = 1_800_000_000.0
    bframes = []
    for seed in range(6):
        rows = walk(30, 200 + seed, start=10.0, vol=0.004)
        o = rows[-1][3]
        up = seed % 2 == 0
        c = o * (1.05 if up else 0.95)
        rows.append([o, max(o, c) * 1.002, min(o, c) * 0.998, c, rows[-1][4] * (3.0 if seed < 4 else 1.2)])
        bframes.append(rows)
    bframes.append(walk(20, 301))
    r20 = walk(19, 302)
    o = r20[-1][3]
    r20.append([o, o * 1.08, o * 0.999, o * 1.07, 10000.0])
    bframes.append(r20)
    for fi, rows in enumerate(bframes):
        df = make_df(rows)
        sym = f"SYM{fi % 4}-USDT-SWAP"
        r = md.detect_atr_breakout(sym, df)
        det["breakout"].append({"frame": fi, "symbol": sym, "now": clk.t, "result": r})
        clk.t += 1200
    write("momentum", {"frames": frames, "veto": veto, "detector": det, "breakout_frames": bframes})


# ── regime ─────────────────────────────────────────────────────────────────
def regime_vectors():
    import market_regime as mr
    clk = Clock(1_800_000_000.5)
    mr.time = clk
    kv = FakeKV()
    install_kv(kv)
    allows = [[r, d, mr.regime_allows_direction(r, d)] for r in ["trending_up", "trending_down", "ranging", "high_vol", "", None]
              for d in ["LONG", "SHORT", "BOTH", ""]]
    steps = []
    mr._cached_regime = None
    mr._cached_at = 0.0

    async def run_seq():
        seq = [["set", "ranging"], ["get"], ["set", "ranging"], ["advance", 100], ["set", "trending_up"], ["get"],
               ["advance", 14400], ["get"], ["advance", 0.5], ["get"], ["set", "high_vol"], ["set", "trending_down"],
               ["hist", 10], ["hist", 0], ["hist", 1], ["hist", -1]]
        for op in seq:
            res = None
            if op[0] == "set":
                mr.set_cached_regime(op[1])
                await asyncio.sleep(0)
                await asyncio.sleep(0)
            elif op[0] == "get":
                res = mr.get_cached_regime()
            elif op[0] == "advance":
                clk.t += op[1]
            elif op[0] == "hist":
                res = await mr.get_regime_history(op[1])
            steps.append({"op": op, "now": clk.t, "result": res, "kv": kv.d.get("regime_history")})
    asyncio.run(run_seq())
    # history edge cases
    hist_cases = []
    for raw in [None, "[]", "not json", json.dumps({"a": 1}), json.dumps([{"ts": float(i), "from": "a", "to": "b"} for i in range(30)]),
                json.dumps("str")]:
        kv.d.clear()
        if raw is not None:
            kv.d["regime_history"] = raw
        asyncio.run(mr._append_regime_history("ranging", "high_vol", 1_800_000_123.5))
        hist_cases.append({"raw": raw, "after": kv.d.get("regime_history")})
    write("regime", {"allows": allows, "steps": steps, "hist": hist_cases})


# ── confluence ─────────────────────────────────────────────────────────────
def confluence_vectors():
    import signal_confluence as sc
    clk = Clock(1_800_000_000.0)
    sc.time = clk
    sc.reset_for_tests()
    ops = [
        ["record", "BTC-USDT-SWAP", "LONG", "LEVELS", 7],
        ["label", "BTC-USDT-SWAP", "LONG", "SMC"],
        ["label", "BTC-USDT-SWAP", "LONG", "LEVELS"],
        ["label", "BTC-USDT-SWAP", "LONG", None],
        ["advance", 60],
        ["record", "BTC-USDT-SWAP", "LONG", "VOLUME", 3.9],
        ["label", "BTC-USDT-SWAP", "LONG", "SMC"],
        ["label", "BTC-USDT-SWAP", "SHORT", "SMC"],
        ["record", "BTC-USDT-SWAP", "LONG", "SMC", 0],
        ["strategies", "BTC-USDT-SWAP", "LONG", None],
        ["strategies", "BTC-USDT-SWAP", "LONG", "SMC"],
        ["label", "BTC-USDT-SWAP", "LONG", "SMC"],
        ["record", "BTC-USDT-SWAP", "LONG", "LEVELS", "5"],
        ["advance", 1740],
        ["strategies", "BTC-USDT-SWAP", "LONG", None],
        ["advance", 0.5],
        ["strategies", "BTC-USDT-SWAP", "LONG", None],
        ["label", "BTC-USDT-SWAP", "LONG", "SMC"],
        ["record", "", "LONG", "SMC", 3],
        ["record", "ETH-USDT-SWAP", "", "SMC", 3],
        ["record", "ETH-USDT-SWAP", "SHORT", "", 3],
        ["record", "ETH-USDT-SWAP", "SHORT", "SMC", None],
        ["stats"],
        ["advance", 3600],
        ["gc"],
        ["stats"],
    ]
    steps = []
    for op in ops:
        res = None
        if op[0] == "record":
            sc.record_signal(op[1], op[2], op[3], op[4])
        elif op[0] == "label":
            res = sc.get_confluence_label(op[1], op[2], current_strategy=op[3])
        elif op[0] == "strategies":
            res = [list(x) for x in sc.get_confluent_strategies(op[1], op[2], exclude_strategy=op[3])]
        elif op[0] == "advance":
            clk.t += op[1]
        elif op[0] == "stats":
            res = sc.get_stats()
        elif op[0] == "gc":
            res = sc.gc_recent()
        steps.append({"op": op, "now": clk.t, "result": res})
    write("confluence", {"steps": steps})


# ── trend monitor ──────────────────────────────────────────────────────────
def trend_series(kind, n, seed, start=100.0):
    rnd = random.Random(seed)
    closes = []
    p = start
    for i in range(n):
        if kind == "up":
            p *= 1 + 0.003 + rnd.gauss(0, 0.002)
        elif kind == "down":
            p *= 1 - 0.003 + rnd.gauss(0, 0.002)
        elif kind == "range":
            p = start * (1 + 0.01 * math.sin(i / 5.0)) * (1 + rnd.gauss(0, 0.001))
        elif kind == "up_flip1":       # up, last bar crashes below the slow EMA
            p = p * (1 + 0.003 + rnd.gauss(0, 0.001)) if i < n - 1 else p * 0.55
        elif kind == "up_flip2":       # up, last two bars crash
            p = p * (1 + 0.003 + rnd.gauss(0, 0.001)) if i < n - 2 else p * 0.75
        elif kind == "down_flip2":
            p = p * (1 - 0.003 + rnd.gauss(0, 0.001)) if i < n - 2 else p * 1.6
        elif kind == "mixed":
            p *= 1 + rnd.gauss(0, 0.01)
        closes.append(p)
    rows = []
    prev = closes[0]
    for c in closes:
        o = prev
        rows.append([o, max(o, c) * 1.001, min(o, c) * 0.999, c, 1000.0])
        prev = c
    return rows


def kb_rows_tm(markup):
    if markup is None:
        return None
    return [[{"text": b.text, "callback_data": b.callback_data} for b in row] for row in markup.inline_keyboard]


def trend_vectors():
    import importlib
    import quiet_hours
    import trend_monitor as tm0
    env_keys = ["TREND_REST_REFRESH_S", "TREND_MTF_BONUS", "TREND_STRONG_PCT", "TREND_STRONG_COUNTER_PENALTY",
                "TREND_MONITOR_INTERVAL_S", "TREND_NOTIFY_TFS", "TREND_MONITOR_ENABLED", "TREND_ALIGNED_NOTIFY", "TREND_CTX_RISK"]

    def reload(env):
        for k in env_keys:
            os.environ.pop(k, None)
        os.environ.update(env)
        return importlib.reload(tm0)

    def consts(tm):
        return {"REST_REFRESH_S": tm.REST_REFRESH_S, "MTF_BONUS": tm.MTF_BONUS, "STRONG_TREND": tm.STRONG_TREND,
                "STRONG_COUNTER_PENALTY": tm.STRONG_COUNTER_PENALTY, "INTERVAL_S": tm.INTERVAL_S,
                "NOTIFY_TFS": list(tm.NOTIFY_TFS), "ENABLED": tm.ENABLED, "ALIGNED_NOTIFY": tm.ALIGNED_NOTIFY,
                "CTX_RISK": tm.CTX_RISK}

    env_cases = [{}, {"TREND_MTF_BONUS": "", "TREND_STRONG_COUNTER_PENALTY": "", "TREND_NOTIFY_TFS": "", "TREND_STRONG_PCT": "",
                      "TREND_MONITOR_INTERVAL_S": "", "TREND_REST_REFRESH_S": ""},
                 {"TREND_MTF_BONUS": "2", "TREND_STRONG_PCT": "150", "TREND_STRONG_COUNTER_PENALTY": "-3", "TREND_MONITOR_INTERVAL_S": "5",
                  "TREND_REST_REFRESH_S": "60", "TREND_NOTIFY_TFS": " 15m , 1D,,", "TREND_MONITOR_ENABLED": "false",
                  "TREND_ALIGNED_NOTIFY": " off "},
                 {"TREND_MONITOR_ENABLED": "FALSE", "TREND_ALIGNED_NOTIFY": "0", "TREND_STRONG_PCT": " 55 ", "TREND_MTF_BONUS": "1_0",
                  "TREND_CTX_RISK": "aligned=1.5, with = 0.8 ,counter=abc,strong_counter=-1,unknown=3,=,counter"},
                 {"TREND_CTX_RISK": "counter=5,strong_counter=0.25,aligned=nan,with=inf"},
                 {"TREND_CTX_RISK": "counter=0.5=1,aligned= 2 "}]
    env_out = [{"env": e, "consts": consts(reload(e))} for e in env_cases]
    tm = reload({})

    # compute_trend / ribbon_strength
    series = {}
    for seed, kind in enumerate(["up", "down", "range", "up_flip1", "up_flip2", "down_flip2", "mixed"]):
        series[kind] = trend_series(kind, 260, 500 + seed)
    compute = []
    lengths = {"15m": [206, 207, 260], "1H": [207, 260], "4H": [260], "1D": [205, 206, 260], "1W": [55, 56, 80], "1M": [25, 26, 40]}
    for tf, lens in lengths.items():
        for kind, rows in series.items():
            for n in lens:
                df = make_df(rows[-n:])
                for prev in [None, "LONG", "SHORT", "RANGE"]:
                    compute.append([tf, kind, n, prev, tm.compute_trend(df, prev, tf)])
    compute.append(["15m", "none", 0, "LONG", tm.compute_trend(None, "LONG", "15m")])
    ribbon = []
    for kind, rows in series.items():
        for n in [59, 60, 61, 120]:
            df = make_df(rows[-n:])
            for trend in ["LONG", "SHORT", "RANGE", None]:
                ribbon.append([kind, n, trend, tm.ribbon_strength(df, trend)])

    # state-dependent helpers
    scenarios = [
        {"trend": {}, "strength": {}},
        {"trend": {"15m": "LONG"}, "strength": {"15m": 70}},
        {"trend": {"15m": "LONG", "1H": "LONG", "4H": "LONG"}, "strength": {"15m": 69}},
        {"trend": {"15m": "SHORT", "1H": "SHORT", "4H": "SHORT", "1D": "SHORT", "1W": "LONG", "1M": "RANGE"}, "strength": {"15m": 91, "1W": 12}},
        {"trend": {"15m": "RANGE", "1H": "RANGE", "4H": "RANGE"}, "strength": {"15m": 100}},
        {"trend": {"15m": "LONG", "1H": "SHORT", "4H": "LONG", "1D": "LONG"}, "strength": {"15m": 85}},
        {"trend": {"1H": "LONG", "4H": "LONG"}, "strength": {}},
    ]
    directions = ["LONG", "SHORT", "long", "", "BOTH", None]
    tfs = ["15m", "1h", "1H", "4h", "30m", "1d", "1W", "1w", "1M", "1m", "2h", "", "xx", None]
    helpers = []
    for si, sc in enumerate(scenarios):
        tm._state.clear()
        tm._strength.clear()
        for tf, t in sc["trend"].items():
            tm._state[tf] = {"trend": t, "since": 1_800_000_000.0, "price": 123.5}
        tm._strength.update(sc["strength"])
        row = {"scenario": si, "aligned_direction": tm.aligned_direction(), "get_all": tm.get_all(),
               "strength": {tf: tm.trend_strength(tf) for tf in ["15m", "1h", "4H", "1W", "x"]},
               "is_strong": {tf: tm.is_strong(tf) for tf in ["15m", "1W", "1H"]}, "per_dir": []}
        for d in directions:
            ent = {"direction": d, "mtf_aligned": tm.mtf_aligned(d), "trend_context": tm.trend_context(d),
                   "trend_context_given": [tm.trend_context(d, a, s) for a in (None, True, False) for s in (None, True, False)],
                   "is_counter": {str(tf): tm.is_counter(d, tf) for tf in ["15m", "1H", "4h", "1M", None]},
                   "card_line": {f"{tf}|{lang}": tm.card_line(d, tf, lang) for tf in tfs for lang in ("ru", "en", "de")}}
            row["per_dir"].append(ent)
        helpers.append(row)

    # apply_mtf_bonus (+ the SMC scanner grade recompute; D6 also after the penalty)
    from smc.signal_builder import GRADES
    bonus = []
    sig_inits = [
        ("quality", 10, {"direction": "LONG", "quality": 7}),
        ("quality", 10, {"direction": "LONG", "quality": 10}),
        ("quality", 10, {"direction": "SHORT", "quality": 1}),
        ("quality", 10, {"direction": "SHORT", "quality": 0}),
        ("quality", 10, {"direction": "LONG", "quality": "6"}),
        ("quality", 10, {"direction": "LONG", "quality": 5.9}),
        ("quality", 10, {"direction": "LONG", "quality": None}),
        ("quality", 10, {"direction": "LONG", "quality": 5, "mtf_aligned": False}),
        ("quality", 10, {"direction": "LONG", "quality": 5, "mtf_aligned": True}),
        ("quality", 10, {"direction": "long", "quality": 5}),
        ("quality", 10, {"quality": 5}),
        ("score", 5, {"direction": "LONG", "score": 4, "grade": "✅ A"}),
        ("score", 5, {"direction": "SHORT", "score": 4, "grade": "✅ A"}),
        ("score", 5, {"direction": "LONG", "score": 5, "grade": "🔥 A+"}),
        ("score", 5, {"direction": "SHORT", "score": 3, "grade": "⚡ B"}),
        ("score", 5, {"direction": "LONG", "score": 2, "grade": "⚡ 2/5"}),
        ("score", 5, {"direction": "SHORT", "score": 2, "grade": "⚡ 2/5"}),
        ("quality", 5, {"direction": "SHORT", "quality": 5}),
        ("quality", 5, {"direction": "LONG", "quality": 5}),
        ("quality", 5, {"direction": "LONG", "quality": 3}),
    ]
    bonus_envs = [{}, {"TREND_MTF_BONUS": "0"}, {"TREND_STRONG_COUNTER_PENALTY": "2"}, {"TREND_STRONG_COUNTER_PENALTY": "0", "TREND_MTF_BONUS": "3"}]
    for env in bonus_envs:
        tm = reload(env)
        for si, sc in enumerate(scenarios):
            tm._state.clear()
            tm._strength.clear()
            for tf, t in sc["trend"].items():
                tm._state[tf] = {"trend": t, "since": 0.0, "price": 0.0}
            tm._strength.update(sc["strength"])
            for attr, cap, init in sig_inits:
                sig = types.SimpleNamespace(**init)
                runs = []
                for _ in range(2):
                    ok = tm.apply_mtf_bonus(sig, attr=attr, cap=cap)
                    bot_grade = d6_grade = getattr(sig, "grade", None)
                    if attr == "score":
                        if ok:
                            sig.grade = GRADES.get(int(sig.score), sig.grade)
                        bot_grade = sig.grade
                        penalised = (not ok) and getattr(sig, "strong_counter", False) and tm.STRONG_COUNTER_PENALTY > 0
                        d6_grade = GRADES.get(int(sig.score), sig.grade) if (ok or penalised) else sig.grade
                    runs.append({"ok": ok, "fields": {k: getattr(sig, k, None) for k in ("mtf_aligned", "strong_counter", "trend_ctx", attr)},
                                 "bot_grade": bot_grade, "d6_grade": d6_grade})
                bonus.append({"env": env, "scenario": si, "attr": attr, "cap": cap, "init": init, "runs": runs})
    tm = reload({})

    ctx = {"mult": {str(c): tm.ctx_risk_mult(c) for c in ["aligned", "with", "counter", "strong_counter", "", None, "x", 0]},
           "label": {f"{c}|{l}": tm.ctx_label(c, l) for c in ["aligned", "with", "counter", "strong_counter", "", None, "x"] for l in ("ru", "en", "de")}}

    # texts
    clk = Clock(1_800_000_000.0)
    tm.time = clk
    texts = []
    for tf in ["15m", "1H", "4H", "1D", "1W", "1M", "1h"]:
        for new, prev in [("LONG", "SHORT"), ("SHORT", "LONG"), ("RANGE", "LONG"), ("LONG", None), ("SHORT", "RANGE"), ("RANGE", None)]:
            for since in [0.0, clk.t - 1800, clk.t - 3599, clk.t - 3600, clk.t - 5400, clk.t - 86400 * 3 - 17, clk.t + 100, clk.t - 89.9]:
                for lang in ("ru", "en", "de"):
                    texts.append([tf, new, prev, since, lang, tm.change_text(tf, new, prev, since, lang)])
    aligned_texts = [[d, s, l, tm.aligned_text(d, s, l)] for d in ("LONG", "SHORT") for s in (None, 85, 0) for l in ("ru", "en", "de")]
    labels = [[tf, l, tm.tf_label(tf, l)] for tf in ["15m", "1D", "1W", "1M", "x"] for l in ("ru", "en", "de")]
    norm = [[str(x), tm.norm_tf(x)] for x in ["15m", "30m", "1h", "1H", "2h", "4h", "4H", "1d", "1D", "1w", "1W", "1M", "1m", "", None, "15M", "2H", "xx", "1Y"]]

    # load_state
    kv = FakeKV()
    install_kv(kv)
    load_cases = []
    raws = [
        json.dumps({"15m": {"trend": "LONG", "since": 1.5, "price": 2}, "1H": {"trend": "SHORT"}, "5m": {"trend": "LONG"},
                    "4H": {"trend": ""}, "1D": "x", "1W": {"trend": 3, "since": None, "price": "4.5"}}),
        json.dumps({"15m": {"trend": "LONG", "since": 1.0}, "1H": {"trend": "SHORT", "since": "abc"}, "4H": {"trend": "RANGE"}}),
        json.dumps(["15m"]),
        "{broken",
        "",
        json.dumps({"1M": {"trend": True, "since": True, "price": False}}),
    ]
    for raw in raws:
        tm._state.clear()
        tm._loaded = False
        kv.d.clear()
        if raw:
            kv.d["trend_state_v1"] = raw
        asyncio.run(tm.load_state())
        load_cases.append({"raw": raw, "state": dict(tm._state)})
    aligned_loads = []
    for raw in [json.dumps({"dir": "LONG", "since": 5}), json.dumps({"dir": "", "since": "7.5"}), json.dumps({"dir": None}),
                json.dumps([1]), "{bad", json.dumps({"dir": "SHORT", "since": "x"}), ""]:
        tm._aligned.clear()
        tm._aligned.update({"dir": None, "since": 0.0, "loaded": False})
        kv.d.clear()
        if raw:
            kv.d["trend_aligned_v1"] = raw
        asyncio.run(tm._load_aligned())
        aligned_loads.append({"raw": raw, "aligned": {k: tm._aligned.get(k) for k in ("dir", "since", "had_kv")}})

    write("trend", {"env": env_out, "series": series, "compute": compute, "ribbon": ribbon, "ribbon_lengths": list(tm.RIBBON_LENGTHS),
                    "scenarios": scenarios, "helpers": helpers, "bonus": bonus, "ctx": ctx, "texts": texts,
                    "aligned_texts": aligned_texts, "labels": labels, "norm": norm, "load_state": load_cases,
                    "aligned_loads": aligned_loads, "tables": {"EMA_BY_TF": {k: list(v) for k, v in tm.EMA_BY_TF.items()},
                                                              "CONFIRM_BY_TF": tm.CONFIRM_BY_TF, "REST_LIMIT": tm.REST_LIMIT,
                                                              "TFS": list(tm.TFS), "REST_TFS": list(tm.REST_TFS), "MTF_TFS": list(tm.MTF_TFS)}})
    trend_refresh_vectors(series)


def trend_refresh_vectors(series):
    """refresh() end to end: WS cache for 15m/1H/4H, REST (throttled) for 1D/1W/1M, kv
    state + aligned dedup, change broadcasts with opt-out / quiet hours / keyboard."""
    import importlib
    import quiet_hours
    import telegram_safe
    import trend_monitor as tm0
    tm = importlib.reload(tm0)
    clk = Clock(1_800_000_000.0)
    tm.time = clk
    quiet_hours.time = clk
    kv = FakeKV()
    install_kv(kv)
    users = [
        {"user_id": 11, "lang": "ru", "quiet_start": -1, "quiet_end": -1},
        {"user_id": 12, "lang": "en", "quiet_start": 0, "quiet_end": 23},
        {"user_id": 13, "lang": None, "quiet_start": 22, "quiet_end": 7},
        {"user_id": 14, "lang": "ru"},
        {"user_id": "x", "lang": "ru"},
        {"user_id": 0, "lang": "en"},
        {"user_id": "15", "lang": "en"},
    ]
    kv.d["trend_notify_off_14"] = "1"

    async def active_users():
        return users
    database.db_get_active_users = active_users
    sends = []

    async def fake_send(bot, uid, text, parse_mode=None, reply_markup=None, disable_notification=None, **kw):
        sends.append({"uid": uid, "text": text, "silent": disable_notification, "kb": kb_rows_tm(reply_markup)})
        return uid != 12 or len(sends) % 2 == 0
    telegram_safe.safe_send_message = fake_send
    real_sleep = asyncio.sleep

    async def no_sleep(*_a, **_k):
        return None
    tm.asyncio = types.SimpleNamespace(sleep=no_sleep)

    ws = {}
    rest_store = {}
    rest_calls = []
    cache_sets = []
    rest_plan = {}

    async def get_candles(sym, tf):
        if tf in ws:
            return ws[tf]
        e = rest_store.get(tf)
        if e and clk.t < e[1]:
            return e[0]
        return None

    async def set_candles(sym, tf, df, ttl_map):
        cache_sets.append([sym, tf, len(df), ttl_map])
        rest_store[tf] = (df, clk.t + list(ttl_map.values())[0])
    import cache as _cache
    _cache.get_candles = get_candles
    _cache.set_candles = set_candles

    class Fetcher:
        async def get_candles(self, sym, tf, limit=300):
            rest_calls.append([sym, tf, limit, clk.t])
            p = rest_plan.get(tf, "none")
            if p == "raise":
                raise RuntimeError("boom")
            if p == "none":
                return None
            if p == "empty":
                return make_df([])
            return make_df(series[p][-limit:] if limit < len(series[p]) else series[p])

    cap = capture("CHM.TrendMonitor")
    plan = [
        # (advance, ws {tf: series kind or None}, rest_plan {tf: kind|none|raise|empty})
        (0, {"15m": "up", "1H": "up", "4H": "range"}, {"1D": "up", "1W": "none", "1M": "raise"}),
        (60, {"15m": "up", "1H": "up", "4H": "up"}, {"1D": "up", "1W": "down", "1M": "up"}),
        (240, {"15m": "up", "1H": "up", "4H": "up"}, {"1W": "down", "1M": "up"}),
        (60, {"15m": "up_flip1", "1H": "up", "4H": "up"}, {}),
        (60, {"15m": "up_flip2", "1H": "up", "4H": "up"}, {}),
        (1800, {"15m": "down", "1H": "down", "4H": "down"}, {"1D": "down", "1W": "up", "1M": "empty"}),
        (60, {"15m": "range", "1H": "down", "4H": "down"}, {}),
        (3600, {"15m": "down", "1H": "down", "4H": "down"}, {"1D": "range", "1W": "up", "1M": "down"}),
        (600, {}, {}),
    ]
    steps = []
    tm._state.clear()
    tm._strength.clear()
    tm._rest_next.clear()
    tm._aligned.clear()
    tm._aligned.update({"dir": None, "since": 0.0, "loaded": False})
    tm._loaded = False
    kv.d["trend_aligned_v1"] = json.dumps({"dir": "SHORT", "since": 1.0})
    asyncio.run(tm.load_state())
    for adv, wsplan, rplan in plan:
        clk.t += adv
        ws.clear()
        for tf, kind in wsplan.items():
            ws[tf] = make_df(series[kind])
        rest_plan.clear()
        rest_plan.update(rplan)
        del sends[:]
        del rest_calls[:]
        del cache_sets[:]
        kv.writes.clear()
        cap.lines.clear()
        changes = asyncio.run(tm.refresh(bot=object(), fetcher=Fetcher()))
        steps.append({"t": clk.t, "ws": wsplan, "rest_plan": rplan, "changes": [list(c) for c in changes],
                      "sends": list(sends), "rest_calls": list(rest_calls), "cache_sets": list(cache_sets),
                      "kv_writes": [w for w in kv.writes if w[0] in ("trend_state_v1", "trend_aligned_v1")],
                      "get_all": tm.get_all(), "rest_next": dict(tm._rest_next),
                      "logs": [l for l in cap.lines if l[0] in ("INFO", "WARNING")]})
    asyncio.sleep = real_sleep
    write("trend_refresh", {"users": users, "opted_out": [14], "initial_kv": {"trend_aligned_v1": json.dumps({"dir": "SHORT", "since": 1.0})},
                            "steps": steps})


# ── free report ────────────────────────────────────────────────────────────
def free_vectors():
    import free_report as fr
    from datetime import datetime, timezone

    clk = Clock(0)

    class FakeDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.fromtimestamp(clk.t, tz)
    fr.datetime = FakeDT
    fr.time = clk
    kv = FakeKV()
    install_kv(kv)
    fr.db = database
    cap = capture("CHM.FreeReport")

    def ts(day, hh, mm=0):
        return datetime(2027, 3, day, hh, mm, tzinfo=timezone.utc).timestamp()

    fields = ["free_signals_date", "free_signals_morning", "free_signals_evening", "free_signals_night", "free_signals_today",
              "free_missed_today", "free_smc_preview_date", "free_smc_preview_today"]

    def new_user(uid, plan="free", **kw):
        d = dict(user_id=uid, sub_plan=plan, lang="ru", free_signals_date="", free_signals_morning=0, free_signals_evening=0,
                 free_signals_night=0, free_signals_today=0, free_missed_today=0, free_smc_preview_date="", free_smc_preview_today=0)
        d.update(kw)
        return types.SimpleNamespace(**d)

    def ustate(u):
        return {k: getattr(u, k, None) for k in fields}

    users = {"a": new_user(101), "b": new_user(102), "pro": new_user(103, plan="pro"), "c": new_user(104, free_signals_date="2027-03-01",
                                                                                                  free_signals_morning=1, free_signals_evening=1, free_signals_today=2)}
    quota_ops = [
        ["should", "a", 1, 5, 30, 9], ["should", "a", 1, 6, 10, 4], ["should", "a", 1, 6, 20, 5], ["record", "a", 1, 6, 21, ""],
        ["should", "a", 1, 7, 0, 9], ["should", "a", 1, 12, 30, 3], ["should", "a", 1, 13, 5, 4], ["should", "a", 1, 13, 6, 5.5],
        ["should", "a", 1, 20, 10, 3], ["record", "a", 1, 20, 11, ""], ["should", "a", 1, 20, 30, 9], ["should", "a", 1, 21, 0, 9],
        ["record", "a", 1, 22, 0, ""], ["record", "a", 1, 23, 0, "morning"], ["should", "a", 2, 6, 0, 5], ["should", "a", 2, 12, 59, 2],
        ["should", "b", 2, 12, 0, 3], ["record", "b", 2, 12, 1, "evening"], ["should", "b", 2, 12, 2, 3], ["should", "b", 2, 20, 59, 3],
        ["should", "pro", 2, 3, 0, 0], ["record", "pro", 2, 3, 1, ""], ["should", "c", 2, 9, 0, 6],
    ]
    quota = []
    for op in quota_ops:
        kind, who, day, hh, mm, arg = op
        clk.t = ts(day, hh, mm)
        u = users[who]
        cap.lines.clear()
        res = None
        if kind == "should":
            res = asyncio.run(fr.should_send_free_signal(u, arg))
        else:
            fr.record_free_signal_sent(u, arg)
        quota.append({"op": op, "now": clk.t, "result": res, "user": ustate(u), "logs": [l[1] for l in cap.lines]})

    # missed buffer + closed profitable (saves run as background tasks inside a loop)
    async def missed_run():
        out = []
        u = new_user(201)
        nou = types.SimpleNamespace(user_id=202)
        for i in range(55):
            clk.t = ts(3, 10, 0) + i * 7.25
            target = [u, nou, 203][i % 3]
            # rr: the LEVELS scanner passes int 0 (SignalResult has no rr) — floats are non-integral here
            fr.record_missed_signal(target, f"S{i}-USDT-SWAP", "LONG" if i % 2 else "SHORT", i % 10, rr=[0, 0.5, 1.25, 2.75][i % 4])
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            out.append({"i": i, "user": ustate(u), "writes": [w for w in kv.writes if w[0] == "free_missed_buffer"]})
            kv.writes.clear()
        clk.t = ts(4, 1, 0)   # next day: free_missed_today resets
        fr.record_missed_signal(u, "X-USDT-SWAP", "LONG", 5)
        out.append({"i": 55, "user": ustate(u), "writes": []})
        closed = []
        for i in range(107):
            clk.t = ts(3, 0, 0) + i * 600.5
            rr = [1.5, -1.0, 0.0, 2.0, 0.75, 3.25][i % 6]
            fr.record_closed_profitable(f"C{i}-USDT-SWAP", "SHORT" if i % 2 else "LONG", rr)
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            closed.append({"i": i, "len": len(fr._closed_profitable), "first": dict(fr._closed_profitable[0]) if fr._closed_profitable else None,
                           "writes": [w for w in kv.writes if w[0] == "free_closed_profitable"]})
            kv.writes.clear()
        return out, closed
    fr._missed_buffer.clear()
    fr._missed_buffer_dirty = 0
    fr._closed_profitable.clear()
    fr._closed_dirty = 0
    kv.writes.clear()
    missed, closed = asyncio.run(missed_run())
    missed_final = {str(k): v for k, v in fr._missed_buffer.items()}

    # SMC preview dedup + quota
    async def preview_run():
        out = []
        fr._FREE_PREVIEW_SENT.clear()
        u = new_user(301)
        pro = new_user(302, plan="pro")
        ops = [["already", 301, "BTC-USDT-SWAP", "LONG", 5, 9], ["should", "u", 5, 9], ["record", "u", 5, 9], ["mark", 301, "BTC-USDT-SWAP", "LONG", 5, 9],
               ["already", 301, "BTC-USDT-SWAP", "LONG", 5, 10], ["already", 301, "BTC-USDT-SWAP", "SHORT", 5, 10],
               ["should", "u", 5, 11], ["record", "u", 5, 11], ["mark", 301, "ETH-USDT-SWAP", "SHORT", 5, 11],
               ["record", "u", 5, 12], ["should", "u", 5, 12], ["should", "pro", 5, 12], ["mark", 302, "SOL-USDT-SWAP", "LONG", 5, 13],
               ["already", 301, "BTC-USDT-SWAP", "LONG", 6, 1], ["should", "u", 6, 1], ["mark", 301, "DOGE-USDT-SWAP", "LONG", 6, 2],
               ["already", 301, "ETH-USDT-SWAP", "SHORT", 6, 3], ["already", "301", "DOGE-USDT-SWAP", "LONG", 6, 3]]
        for op in ops:
            day, hh = op[-2], op[-1]
            clk.t = ts(day, hh, 0)
            cap.lines.clear()
            res = None
            if op[0] == "already":
                res = fr._free_preview_already_sent_today(op[1], op[2], op[3])
            elif op[0] == "mark":
                fr._mark_free_preview_sent(op[1], op[2], op[3])
                await asyncio.sleep(0)
                await asyncio.sleep(0)
            elif op[0] == "should":
                res = await fr.should_send_free_smc_preview(u if op[1] == "u" else pro)
            elif op[0] == "record":
                fr.record_free_smc_preview_sent(u)
            out.append({"op": op, "now": clk.t, "result": res, "user": ustate(u),
                        "writes": [w for w in kv.writes if w[0] == "free_preview_sent"], "logs": [l[1] for l in cap.lines if l[0] == "INFO"]})
            kv.writes.clear()
        return out
    preview = asyncio.run(preview_run())

    cards = []
    from i18n import t as _t
    for sym, d, score, entry, sl, tp1 in [("BTC-USDT-SWAP", "LONG", 4, 64123.456789, 63000.5, 66000.0), ("PEPE-USDT-SWAP", "SHORT", 5, 0.0000123456789, 0.0000130001, 0.00001),
                                          ("ETH-USDT-SWAP", "LONG", None, 3456.5, 3400.0, 3600.25), ("X-USDT-SWAP", "SHORT", 3.7, 1e-07, 2e-07, 5e-08)]:
        sig = types.SimpleNamespace(direction=d, score=score, entry=entry, sl=sl, tp1=tp1)
        for lang in ("ru", "en", "de"):
            cards.append({"sig": {"direction": d, "score": score, "entry": entry, "sl": sl, "tp1": tp1}, "symbol": sym, "lang": lang,
                          "text": _t("smc_pro_preview_card", lang, symbol=sym, direction=sig.direction, score=int(sig.score or 0),
                                     entry=f"{sig.entry:.6g}", sl=f"{sig.sl:.6g}", tp1=f"{sig.tp1:.6g}")})

    # load_persistent_buffers
    loads = []
    clk.t = ts(7, 12, 0)
    for missed_raw, closed_raw, prev_raw in [
        (json.dumps({"5": [{"symbol": "A"}], "6": []}), json.dumps([{"symbol": "B", "direction": "LONG", "result_rr": 1.5, "closed_at": 1.0}]),
         json.dumps({"7": {"A:LONG": "2027-03-07", "B:SHORT": "2027-03-06"}, "8": {"C:LONG": "2027-03-06"}, "9": None})),
        ("{bad", "[bad", "{bad"),
        (None, None, None),
        (json.dumps({"x": []}), json.dumps({"a": 1}), json.dumps({"10": {"Z:SHORT": "2027-03-07"}})),
    ]:
        fr._missed_buffer.clear()
        fr._closed_profitable.clear()
        fr._FREE_PREVIEW_SENT.clear()
        kv.d.clear()
        for k, v in (("free_missed_buffer", missed_raw), ("free_closed_profitable", closed_raw), ("free_preview_sent", prev_raw)):
            if v is not None:
                kv.d[k] = v
        asyncio.run(fr.load_persistent_buffers())
        loads.append({"missed": missed_raw, "closed": closed_raw, "preview": prev_raw,
                      "missed_buffer": {str(k): v for k, v in fr._missed_buffer.items()},
                      "closed_buffer": json.loads(json.dumps(fr._closed_profitable)),
                      "preview_sent": {str(k): dict(v) for k, v in fr._FREE_PREVIEW_SENT.items()}})

    # evening report
    clk.t = ts(8, 21, 0)
    fr._closed_profitable = []
    fr._missed_buffer = {}
    fr._closed_profitable.extend([
        {"symbol": "OLD-USDT-SWAP", "direction": "LONG", "result_rr": 9.0, "closed_at": ts(7, 23, 0)},
        {"symbol": "BTC-USDT-SWAP", "direction": "LONG", "result_rr": 1.25, "closed_at": ts(8, 0, 0)},
        {"symbol": "ETH-USDT", "direction": "SHORT", "result_rr": 2.0, "closed_at": ts(8, 3, 0)},
        {"symbol": "SOL-USDT-SWAP", "direction": "LONG", "result_rr": 0.05, "closed_at": ts(8, 4, 0)},
        {"symbol": "XRP-USDT-SWAP", "direction": "SHORT", "result_rr": 3.35, "closed_at": ts(8, 5, 0)},
        {"symbol": "ADA-USDT-SWAP", "direction": "LONG", "result_rr": 0.25, "closed_at": ts(8, 6, 0)},
        {"symbol": "DOGE-USDT-SWAP", "direction": "SHORT", "result_rr": 1.0, "closed_at": ts(8, 20, 59)},
    ])
    fr._missed_buffer.clear()
    fr._missed_buffer[1] = [{"symbol": "Q"}]
    rep_users = [
        new_user(401, free_signals_date="2027-03-08", free_signals_morning=1, free_signals_evening=0, free_signals_today=1),
        new_user(402, lang="en", free_signals_date="2027-03-08", free_signals_morning=1, free_signals_evening=1, free_signals_today=2),
        new_user(403, free_signals_date="2027-03-07", free_signals_morning=1, free_signals_evening=1),
        new_user(404, plan="pro", free_signals_date="2027-03-08", free_signals_morning=1),
        new_user(405, lang="", free_signals_date="2027-03-08", free_signals_morning=0, free_signals_evening=0, free_signals_today=3),
        new_user(406, lang="de", free_signals_date="2027-03-08"),
    ]
    sent = []

    class Bot:
        async def send_message(self, uid, text, parse_mode=None):
            sent.append([uid, text])

    class UM:
        async def all_users(self):
            return rep_users

    async def no_sleep(*_a, **_k):
        return None
    fr.asyncio = types.SimpleNamespace(sleep=no_sleep, get_event_loop=asyncio.get_event_loop,
                                       get_running_loop=asyncio.get_running_loop)
    kv.writes.clear()
    asyncio.run(fr._send_evening_report(Bot(), UM()))
    report = {"now": clk.t, "closed": [{"symbol": "OLD-USDT-SWAP", "direction": "LONG", "result_rr": 9.0, "closed_at": ts(7, 23, 0)},
                                        {"symbol": "BTC-USDT-SWAP", "direction": "LONG", "result_rr": 1.25, "closed_at": ts(8, 0, 0)},
                                        {"symbol": "ETH-USDT", "direction": "SHORT", "result_rr": 2.0, "closed_at": ts(8, 3, 0)},
                                        {"symbol": "SOL-USDT-SWAP", "direction": "LONG", "result_rr": 0.05, "closed_at": ts(8, 4, 0)},
                                        {"symbol": "XRP-USDT-SWAP", "direction": "SHORT", "result_rr": 3.35, "closed_at": ts(8, 5, 0)},
                                        {"symbol": "ADA-USDT-SWAP", "direction": "LONG", "result_rr": 0.25, "closed_at": ts(8, 6, 0)},
                                        {"symbol": "DOGE-USDT-SWAP", "direction": "SHORT", "result_rr": 1.0, "closed_at": ts(8, 20, 59)}],
              "users": [vars(u) for u in rep_users], "sent": sent, "writes": kv.writes[:]}
    # report with fewer closed entries and without any
    sent2 = []

    class Bot2:
        async def send_message(self, uid, text, parse_mode=None):
            sent2.append([uid, text])
    fr._closed_profitable.clear()
    fr._closed_profitable.extend([{"symbol": "AAA-USDT-SWAP", "direction": "LONG", "result_rr": 0.5, "closed_at": ts(8, 1, 0)}])
    asyncio.run(fr._send_evening_report(Bot2(), UM()))
    report["sent_small"] = sent2
    report["closed_small"] = [{"symbol": "AAA-USDT-SWAP", "direction": "LONG", "result_rr": 0.5, "closed_at": ts(8, 1, 0)}]
    write("free", {"quota": quota, "missed": missed, "missed_final": missed_final, "closed": closed, "preview": preview,
                   "cards": cards, "loads": loads, "report": report, "quota_const": fr._FREE_SMC_PREVIEW_DAILY_QUOTA})


# ── volume filter ──────────────────────────────────────────────────────────
def volume_filter_vectors():
    import volume_filter as vf
    import scanner_mid
    rnd = random.Random(77)
    coins = [f"C{i:02d}-USDT-SWAP" for i in range(40)]
    vol = {}
    for i, c in enumerate(coins):
        if i % 9 == 4:
            continue                       # missing → 0
        v = rnd.choice([0, 0, 150_000, 300_000, 500_000, 1_000_000, 2_500_000, 7_000_000, 7_000_000, 12_345_678.5, 50_000_000])
        vol[c] = v
    U = lambda **kw: types.SimpleNamespace(**kw)  # noqa: E731
    groups = {
        "usdt": [U(vol_filter_mode="usdt", max_coins_count=50, min_volume_usdt=1_000_000)],
        "usdt_low": [U(vol_filter_mode="usdt", max_coins_count=50, min_volume_usdt=300_000), U(vol_filter_mode="usdt", max_coins_count=10, min_volume_usdt=5_000_000)],
        "count": [U(vol_filter_mode="count", max_coins_count=7, min_volume_usdt=1_000_000), U(vol_filter_mode="count", max_coins_count=12, min_volume_usdt=0)],
        "both": [U(vol_filter_mode="both", max_coins_count=15, min_volume_usdt=2_000_000)],
        "mixed": [U(vol_filter_mode="count", max_coins_count=9, min_volume_usdt=3_000_000), U(vol_filter_mode="usdt", max_coins_count=20, min_volume_usdt=600_000)],
        "off": [U(vol_filter_mode="off", max_coins_count=5, min_volume_usdt=9_000_000), U(vol_filter_mode="count", max_coins_count=3, min_volume_usdt=1)],
        "zero_min": [U(vol_filter_mode="usdt", max_coins_count=0, min_volume_usdt=0), U(vol_filter_mode="usdt", max_coins_count=None, min_volume_usdt=None)],
        "defaults": [U()],
        "neg_count": [U(vol_filter_mode="count", max_coins_count=-5, min_volume_usdt=1)],
        "none": [],
    }
    cases = []
    for name, users in groups.items():
        for cap, floor in [(200, 0.0), (10, 0.0), (0, 0.0), (200, 500_000.0), (5, 2_000_000.0)]:
            got = vf.apply_vol_filter(coins, users, vol, lambda u: getattr(u, "min_volume_usdt", 0), cap_count=cap, floor_usdt=floor,
                                      strategy_tag="SMC")
            cases.append({"group": name, "cap": cap, "floor": floor, "result": got})
    cases.append({"group": "usdt", "cap": 200, "floor": 0.0, "coins": [], "result": vf.apply_vol_filter([], groups["usdt"], vol, lambda u: 0)})
    mid = []
    fake = types.SimpleNamespace(fetcher=types.SimpleNamespace(vol_by_sym=vol))
    mid_groups = {k: v for k, v in groups.items() if k not in ("zero_min",)}
    mid_groups["zero_min_mid"] = [U(vol_filter_mode="usdt", max_coins_count=0, min_volume_usdt=0)]
    mid_groups["huge_min"] = [U(vol_filter_mode="usdt", max_coins_count=50, min_volume_usdt=1e12)]
    for name, users in mid_groups.items():
        jobs = [types.SimpleNamespace(user=u) for u in users]
        mid.append({"group": name, "result": scanner_mid.MidScanner._apply_vol_filter(fake, coins, jobs)})
    write("volume_filter", {"coins": coins, "vol": vol,
                            "groups": {k: [vars(u) for u in v] for k, v in groups.items()},
                            "mid_groups": {k: [vars(u) for u in v] for k, v in mid_groups.items()},
                            "cases": cases, "mid": mid})


# ── coin quality learner ───────────────────────────────────────────────────
def coin_quality_vectors():
    import sqlite3
    import coin_quality_learner as cq
    clk = Clock(1_800_000_000.0)
    cq.time = clk
    kv = FakeKV()
    install_kv(kv)
    tmp = tempfile.mkdtemp()
    path = os.path.join(tmp, "cq.db")
    with open(os.path.join(FIX, "trades_ddl.sql"), encoding="utf-8") as fh:
        ddl = fh.read()
    conn = sqlite3.connect(path)
    conn.executescript(ddl)
    rows = []
    rnd = random.Random(5)
    day = 86400

    def add(sym, strat, result, rr, age_days):
        rows.append({"trade_id": f"t{len(rows)}", "user_id": 1, "symbol": sym, "direction": "LONG", "entry": 1.0, "sl": 0.9,
                     "tp1": 1.1, "tp2": 1.2, "tp3": 1.3, "strategy": strat, "result": result, "result_rr": rr,
                     "created_at": clk.t - age_days * day})
    for _ in range(12):
        add("BAD-USDT-SWAP", "SMC", rnd.choice(["SL", "SL", "TP1"]), rnd.choice([-1.0, -1.0, 0.5]), rnd.uniform(1, 29))
    for _ in range(9):
        add("FEW-USDT-SWAP", "LEVELS", "SL", -1.0, 3)
    for _ in range(15):
        add("GOOD-USDT-SWAP", "VOLUME", rnd.choice(["TP1", "TP2", "SL"]), rnd.choice([1.25, 2.0, -1.0]), rnd.uniform(1, 25))
    for _ in range(11):
        add("btc-usdt-swap", "smc", "SL", -0.75, 2)
    for _ in range(10):
        add("GER-USDT-SWAP", "GERCHIK", "SL", -1.0, 2)
    for _ in range(6):
        add("MIX-USDT-SWAP", "LEVELS", "SL", -1.0, 2)
    for _ in range(4):
        add("MIX-USDT-SWAP", "LEVELS", "", 0.0, 2)          # open rows count (quirk)
    for _ in range(3):
        add("MIX-USDT-SWAP", "LEVELS", "SKIP", 0.0, 2)      # excluded
    add("MIX-USDT-SWAP", "LEVELS", "SL", -1.0, 31)           # too old
    for _ in range(10):
        add("PF-USDT-SWAP", "SMC", "SL", -1.0, 4)
    for _ in range(10):
        add("PF-USDT-SWAP", "SMC", "TP2", 0.75, 4)           # PF 0.75 ≥ 0.7 → not banned
    for _ in range(10):
        add("ZERO-USDT-SWAP", "SMC", "BE", 0.0, 4)          # avg 0 → not banned
    for r in rows:
        keys = list(r)
        conn.execute(f"INSERT INTO trades ({', '.join(keys)}) VALUES ({', '.join('?' * len(keys))})", [r[k] for k in keys])
    conn.execute("INSERT INTO trades (trade_id, user_id, symbol, direction, entry, sl, tp1, tp2, tp3, strategy, result, result_rr, created_at) "
                 "VALUES ('tnull', 1, 'NUL-USDT-SWAP', 'LONG', 1, 1, 1, 1, 1, 'SMC', 'SL', NULL, ?)", (clk.t - 100,))
    conn.commit()
    conn.close()
    database._db_path = path
    cap = capture("CHM.CoinQuality")
    steps = []
    kv.d["coin_blacklist_v1"] = json.dumps({"OLD-USDT-SWAP::SMC": clk.t - 5, "KEEP-USDT-SWAP::LEVELS": clk.t + 3600.5,
                                            "lower-usdt-swap::smc": clk.t + 999, "nocolon": clk.t + 50, "BAD-USDT-SWAP::SMC": "x"})

    def check():
        return {f"{s}|{st}": cq.is_blacklisted(s, st) for s, st in [("BAD-USDT-SWAP", "SMC"), ("bad-usdt-swap", "smc"), ("BTC-USDT-SWAP", "SMC"),
                                                                    ("KEEP-USDT-SWAP", "LEVELS"), ("lower-usdt-swap", "smc"), ("FEW-USDT-SWAP", "LEVELS"),
                                                                    ("GER-USDT-SWAP", "GERCHIK"), ("MIX-USDT-SWAP", "LEVELS"), ("", "SMC"),
                                                                    ("PF-USDT-SWAP", "SMC")]}

    def snap():
        return {f"{k[0]}::{k[1]}": v for k, v in cq.get_blacklist_snapshot().items()}

    async def run():
        cap.lines.clear()
        n = await cq.restore_blacklist_from_kv()
        steps.append({"op": "restore", "now": clk.t, "result": n, "snapshot": snap(), "check": check(),
                      "logs": [l[1] for l in cap.lines if l[0] in ("INFO", "WARNING")]})
        cap.lines.clear()
        kv.writes.clear()
        res = await cq.recompute_blacklist()
        steps.append({"op": "recompute", "now": clk.t, "result": res, "snapshot": snap(), "check": check(),
                      "kv": [w[1] for w in kv.writes], "logs": [l[1] for l in cap.lines if l[0] in ("INFO", "WARNING")]})
        clk.t += 14 * day + 1
        cap.lines.clear()
        steps.append({"op": "check_later", "now": clk.t, "check": check(), "snapshot": snap()})
        kv.writes.clear()
        res = await cq.recompute_blacklist()
        steps.append({"op": "recompute2", "now": clk.t, "result": res, "snapshot": snap(), "check": check(),
                      "kv": [w[1] for w in kv.writes], "logs": [l[1] for l in cap.lines if l[0] in ("INFO", "WARNING")]})
    cq._blacklist.clear()
    asyncio.run(run())
    write("coin_quality", {"rows": rows, "null_row": {"created_at": 1_800_000_000.0 - 100}, "initial_kv":
                           {"coin_blacklist_v1": json.dumps({"OLD-USDT-SWAP::SMC": 1_800_000_000.0 - 5, "KEEP-USDT-SWAP::LEVELS": 1_800_000_000.0 + 3600.5,
                                                             "lower-usdt-swap::smc": 1_800_000_000.0 + 999, "nocolon": 1_800_000_000.0 + 50,
                                                             "BAD-USDT-SWAP::SMC": "x"})},
                           "steps": steps})


# ── signal trades repo ─────────────────────────────────────────────────────
def repo_vectors():
    import sqlite3
    from db import core, trades as dbt, signal_progress as sp, trade_events as te, signals as dbs
    clk = Clock(1_800_000_000.5)
    dbt.time = clk
    te._t = clk
    tmp = tempfile.mkdtemp()
    path = os.path.join(tmp, "repo.db")
    with open(os.path.join(FIX, "trades_ddl.sql"), encoding="utf-8") as fh:
        ddl = fh.read()
    c0 = sqlite3.connect(path)
    c0.executescript(ddl)
    c0.commit()
    c0.close()
    core._db_path = path
    core._read_pool = None
    core._write_conn = None
    database._db_path = path
    cap = capture("CHM.DB")

    def all_rows():
        c = sqlite3.connect(path)
        c.row_factory = sqlite3.Row
        out = [dict(r) for r in c.execute("SELECT * FROM trades ORDER BY trade_id")]
        ev = [dict(r) for r in c.execute("SELECT * FROM trade_events ORDER BY id")]
        c.close()
        return out, ev

    base = {"user_id": 7, "symbol": "BTC-USDT-SWAP", "direction": "LONG", "entry": 100.0, "sl": 98.0, "tp1": 104.0, "tp2": 106.0, "tp3": 109.0}
    steps = []

    async def run():
        async def step(name, coro_or_val):
            cap.lines.clear()
            try:
                res = await coro_or_val if asyncio.iscoroutine(coro_or_val) else coro_or_val
                err = None
            except Exception as e:  # noqa: BLE001
                res, err = None, type(e).__name__
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            rows, ev = all_rows()
            steps.append({"name": name, "now": clk.t, "result": res, "error": err, "rows": rows, "events": ev,
                          "logs": [l[1] for l in cap.lines if l[0] in ("INFO", "WARNING")]})
        await step("add_t1", dbt.db_add_trade({**base, "trade_id": "t1", "quality": 7, "timeframe": "1h", "breakout_type": "Отскок",
                                               "created_at": clk.t, "strategy": "LEVELS", "is_counter_trend": True, "mtf_aligned": False,
                                               "trend_ctx": "with", "state": "PENDING", "state_changed_at": clk.t, "original_sl": 98.0,
                                               "signal_msg_id": 55, "progress_stage": "TP1", "foo": 1, "preset_name": None,
                                               "signal_type": "x" * 70, "rsi": 51.5, "volume_ratio": 1.0}))
        await step("add_dup", dbt.db_add_trade({**base, "trade_id": "t1", "entry": 1.0}))
        await step("add_empty", dbt.db_add_trade({"foo": 1}))
        await step("add_t2", dbt.db_add_trade({**base, "trade_id": "t2", "direction": "SHORT", "entry_lo": 99.0, "entry_hi": 101.0,
                                               "created_at": clk.t - 3600, "strategy": "SMC", "state": "PENDING", "tp_placed": 1}))
        await step("add_t3", dbt.db_add_trade({**base, "trade_id": "t3", "created_at": clk.t - 80 * 3600, "strategy": "VOLUME",
                                               "state": "PENDING", "order_id": "ex-1"}))
        await step("add_t4", dbt.db_add_trade({**base, "trade_id": "t4", "created_at": clk.t - 4 * 86400, "strategy": "LEVELS", "state": "PENDING"}))
        clk.t += 10
        await step("state_placing", dbt.db_set_trade_state("t2", "PLACING", bump_attempts=True))
        await step("state_open", dbt.db_set_trade_state("t2", "OPEN"))
        await step("state_back", dbt.db_set_trade_state("t2", "PLACING"))
        await step("state_bad", dbt.db_set_trade_state("t2", "WAT"))
        await step("state_no_pred", dbt.db_set_trade_state("t2", "PENDING"))
        await step("state_expected", dbt.db_set_trade_state("t1", "FAILED", expected_from=frozenset({"PENDING", "CLOSED"})))
        clk.t += 5
        await step("result_tp1", dbt.db_set_trade_result("t2", "TP1", 2.0))
        await step("result_again", dbt.db_set_trade_result("t2", "SL", -1.0))
        await step("result_skip", dbt.db_set_trade_result("t3", "SKIP", 0.0, skip_reason="not_delivered_" + "y" * 80))
        await step("result_overwrite", dbt.db_set_trade_result("t3", "TP2", 3.0, closed_pnl_usd=12.5, allow_overwrite_skip=True))
        await step("result_unknown", dbt.db_set_trade_result("t4", "LIQUIDATED", -2.0, closed_pnl_usd=-50))
        await step("result_missing", dbt.db_set_trade_result("nope", "SL", -1.0))
        await step("note", dbt.db_set_trade_note("t1", note="заметка " * 80, skip_reason="manual"))
        await step("note_none", dbt.db_set_trade_note("t1"))
        clk.t += 5
        await step("add_p1", dbt.db_add_trade({**base, "trade_id": "p1", "created_at": clk.t - 100, "strategy": "LEVELS", "state": "PENDING"}))
        await step("add_p2", dbt.db_add_trade({**base, "trade_id": "p2", "created_at": clk.t - 200, "strategy": "SMC", "state": "PENDING",
                                               "entry_lo": 99.5, "entry_hi": 100.5}))
        await step("add_p3", dbt.db_add_trade({**base, "trade_id": "p3", "created_at": clk.t - 73 * 3600, "strategy": "VOLUME", "state": "PENDING"}))
        await step("msg_p1", sp.db_set_signal_msg_id("p1", 101, json.dumps({"html": "<b>x</b> ✅", "kb": None}, ensure_ascii=False)))
        await step("msg_p2", sp.db_set_signal_msg_id("p2", 102))
        await step("msg_p3", sp.db_set_signal_msg_id("p3", 103, "{}"))
        await step("msg_zero", sp.db_set_signal_msg_id("t4", 0, "x"))
        await step("trackable", sp.db_get_trackable_signals(clk.t - 72 * 3600))
        await step("trackable_lim", sp.db_get_trackable_signals(clk.t - 100 * 3600, limit=1))
        await step("advance_ok", sp.db_advance_signal_progress("p1", "", "ENTRY", clk.t - 50))
        await step("advance_stale", sp.db_advance_signal_progress("p1", "", "TP1", clk.t - 40))
        await step("advance_ok2", sp.db_advance_signal_progress("p1", "ENTRY", "TP1", clk.t - 30))
        await step("expire_cands", sp.db_get_expire_candidates(clk.t, 72 * 3600))
        await step("expire_mark", sp.db_mark_signal_expired("p3", "", 0.42, clk.t))
        await step("expire_mark_again", sp.db_mark_signal_expired("p3", "", 0.5, clk.t))
        await step("trackable_after", sp.db_get_trackable_signals(clk.t - 100 * 3600))
        await step("evt_add", te.db_add_trade_event("p1", te.EVT_NOTIFICATION_SENT, {"ok": True, "uid": 7, "rr": 1.5, "n": 2.0,
                                                                                      "txt": "привет", "nested": {"a": [1, None]}}))
        await step("evt_empty", te.db_add_trade_event("p1", te.EVT_FILTER_BLOCK, {}))
        await step("evt_none", te.db_add_trade_event("", te.EVT_FILTER_BLOCK, {"x": 1}))
        await step("evt_long", te.db_add_trade_event("p2", te.EVT_ANOMALY_DETECTED, {"blob": "ж" * 5000}))
        await step("evt_get", te.db_get_trade_events("p1"))
        await step("evt_get_lim", te.db_get_trade_events("t2", limit=1))
        await step("signals_get", dbs.get_signal("p2"))
        await step("signals_records", dbs.get_signal_records("zzz"))
        await step("signals_tp", dbs.update_signal_tp("p2", tp2=107.5))
        await step("signals_record", dbs.add_trade_record(7, "p2", "tp3", 4.5))
        await step("user_trades", dbt.db_get_user_trades(7))
        clk.t += 86400 * 31
        await step("evt_gc", te.gc_trade_events(30))
        await step("ghost_user", dbt.db_cleanup_ghost_trades(7, max_age_days=3))
        await core.close_write_conn()
    asyncio.run(run())
    write("repo", {"base": base, "steps": steps, "allowed": sorted(dbt._ALLOWED_TRADE_COLS), "states": sorted(dbt.TRADE_STATES),
                   "transitions": {k: sorted(v) for k, v in dbt._ALLOWED_TRANSITIONS.items()},
                   "final_stages": sorted(sp.FINAL_STAGES), "stop_results": list(sp._STOP_RESULTS)})


# ── small primitives: quality scale, price formats, lite, watermark, position line ──
def primitives_vectors():
    import quality_scale as qs
    import signal_format as sfmt
    import volume_scanner as vsc
    from smc import scanner as smcs
    import watermark as wm
    import position_size as ps
    import balance_cache
    import trend_monitor as tm
    from i18n import t as _t
    out = {}
    q_in = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, -1, 4.9, 5.5, 7.99, "7", " 8 ", "abc", None, True, False, float("nan"), float("inf"),
            float("-inf"), "nan", "1_0", "", 0.0]
    out["levels_stars"] = [[q, qs.levels_stars(q)] for q in q_in]
    s_in = [0, 1, 2, 3, 4, 5, 6, -1, 3.7, "4", "4.5", None, True, float("nan"), "", " 2 "]
    out["stars_str"] = [[n, qs.stars_str(n)] for n in s_in]
    p_in = [None, "abc", "12.5", 0, -1.0, 1e-9, 0.000123456, 0.00001, 0.5, 0.999999, 1, 1.23456789, 9.99995, 99.99, 99.95, 100, 123.456,
            9999.94, 9999.96, 12345.678, 1e7, 2.5e-5, 0.1, float("inf"), True, 3]
    fps = []
    for v in p_in:
        row = [v]
        for fn in (smcs._fp, sfmt._fmt_price, vsc._fp):
            try:
                row.append(fn(v))
            except Exception as e:  # noqa: BLE001
                row.append({"error": type(e).__name__})
        fps.append(row)
    out["fp"] = fps
    lite = []
    lite_cases = [
        dict(symbol="BTC-USDT-SWAP", direction="LONG", quality=8, entry=100, sl=98, tp1=104, strategy="LEVELS", lang="ru", quality_scale=10),
        dict(symbol="BTC-USDT-SWAP", direction="SHORT", quality=4, entry=100.0, sl=102.0, tp1=95.0, tp2=None, tp3=0, strategy="SMC", lang="en"),
        dict(symbol="X<Y>", direction="short", quality="3", entry=1.0, sl=1.05, tp1=1.0, tp2=0.9, tp3=0.8, strategy="", lang="ru"),
        dict(symbol="Q", direction="LONG", quality=None, entry=0.0, sl=1.0, tp1=2.0, strategy="VOLUME", lang="de"),
        dict(symbol="Q", direction="", quality=7.9, entry=50.0, sl=49.0, tp1=55.0, tp2=60.0, tp3=65.0, strategy="levels", lang="en"),
        dict(symbol="Q", direction="LONG", quality=12, entry=50.0, sl=49.0, tp1=55.0, strategy="SMC", lang="ru", quality_scale=0),
        dict(symbol="Q", direction="LONG", quality=-3, entry=50.0, sl=49.0, tp1=55.0, strategy="SMC", lang="ru"),
        dict(symbol="PEPE-USDT-SWAP", direction="SHORT", quality=5, entry=0.00001234, sl=0.0000129, tp1=0.0000118, tp2=0.0000112,
             tp3=0.00001, strategy="SMC & co", lang="en"),
        dict(symbol="Q", direction="LONG", quality="abc", entry=50.0, sl=49.0, tp1=55.0, strategy="SMC", lang="ru"),
    ]
    for kw in lite_cases:
        lite.append([kw, sfmt.format_signal_lite(**kw)])
    out["lite"] = lite
    uids = [0, 1, 2, 123456789, 2 ** 40 - 1, 2 ** 40, 2 ** 41 + 5, 7107654772]
    out["wm_encode"] = [[u, wm.wm_encode(u)] for u in uids]
    texts = ["", "a", "ab", "🟢 <b>LONG</b>", "↔️ y", "日本語"]
    out["wm_inject"] = [[t_, u, wm.wm_inject(t_, u)] for t_ in texts for u in (5, 123456789)]
    out["wm_decode"] = [[t_, wm.wm_decode(t_)] for t_ in [wm.wm_inject("hello", 42), "plain", wm.wm_encode(7)[:39], wm.wm_encode(7) * 2,
                                                          "x" + wm.wm_encode(2 ** 40 - 1)]]
    # position line
    plines = []
    users = [dict(trade_risk_pct=1.0, trade_leverage=10), dict(trade_risk_pct=2.5, trade_leverage=3), dict(trade_risk_pct=0, trade_leverage=0),
             dict(trade_risk_pct=None, trade_leverage=None), dict(), dict(trade_risk_pct=0.75, trade_leverage=50), dict(trade_risk_pct=5.0, trade_leverage=1)]
    entries = [(100.0, 98.0), (64123.5, 63000.0), (0.0001234, 0.0001200), (100.0, 100.0), (0.0, 1.0), (2.0, 2.5)]
    ctxs = ["", "aligned", "with", "counter", "strong_counter", "weird"]
    bals = [None, 0.0, -5.0, 87.5, 2500.0, 1234567.0]

    async def bal_of(b):
        async def f(_u, _e):
            return b
        balance_cache.get_cached_balance = f
    for ui, u in enumerate(users):
        for ei, (e, s_) in enumerate(entries):
            for ci, cx in enumerate(ctxs):
                b = bals[(ui + ei + ci) % len(bals)]
                for lang in ("ru", "en"):
                    asyncio.run(bal_of(b))
                    line = asyncio.run(ps.position_line(types.SimpleNamespace(**u), e, s_, lang, ctx=cx))
                    plines.append({"user": u, "entry": e, "sl": s_, "ctx": cx, "balance": b, "lang": lang, "line": line})
    out["position_line"] = plines
    out["compute"] = [[b, r, e, s_, lv, ps.compute(b, r, e, s_, lv)] for b in (1000.0, 50.0) for r in (1.0, 0.0, 3.0)
                      for (e, s_) in ((100.0, 99.0), (100.0, 50.0), (0.0, 1.0)) for lv in (10, 0, 1)]
    out["usd"] = [[v, ps._usd(v)] for v in [0, 0.04, 0.05, 99.94, 99.96, 100, 1234.5, 1e6, 12.25]]
    out["trend_kb"] = [[l, kb_rows_tm(tm._keyboard(l))] for l in ("ru", "en", "de")]
    out["i18n_free"] = {k: {"ru": __import__("i18n").MESSAGES[k].get("ru"), "en": __import__("i18n").MESSAGES[k].get("en")}
                        for k in ["free_report_title", "free_report_received", "free_report_closed_today_header", "free_report_more",
                                  "free_report_total", "free_report_upsell_pro", "smc_pro_preview_card"]}
    out["t_format"] = [[k, l, kw, _t(k, l, **kw)] for k, l, kw in [
        ("free_report_total", "ru", {"r": 7.85}), ("free_report_total", "en", {"r": 0.05}), ("free_report_received", "en", {"n": 3}),
        ("free_report_received", "ru", {}), ("smc_sl_inline_warning", "en", {"sl_pct": "6.1"}), ("smc_confirmations", "de", {"score": 4}),
        ("no_such_key", "ru", {"a": 1})]]
    write("primitives", out)


SECTIONS = {
    "volume_filter": volume_filter_vectors,
    "coin_quality": coin_quality_vectors,
    "repo": repo_vectors,
    "primitives": primitives_vectors,
    "free": free_vectors,
    "trend": trend_vectors,
    "registry": registry_vectors,
    "freshness": freshness_vectors,
    "momentum": momentum_vectors,
    "regime": regime_vectors,
    "confluence": confluence_vectors,
}


def main(argv):
    names = argv or list(SECTIONS)
    for n in names:
        SECTIONS[n]()


if __name__ == "__main__":
    main(sys.argv[1:])
