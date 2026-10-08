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


SECTIONS = {
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
