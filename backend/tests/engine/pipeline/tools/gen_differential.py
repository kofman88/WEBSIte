"""gen_differential.py — randomized differential vectors for the M9a pipeline (adversarial
verification): random event sequences / tuples run through the bot's own modules, replayed
by differential.test.js against the JS ports. Read-only use of the bot checkout:

  cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \
    <venv>/bin/python <site>/backend/tests/engine/pipeline/tools/gen_differential.py [section ...]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json

Sections (fixtures/diff_<section>.json):
  loads     json.loads on valid / malformed / mutated documents (values, key order, error text)
  registry  signal_registry: 40 random sequences of peek / commit (ttl_s) / can_send / *_multi /
            claim_multi / apply_cooldown / clear / cleanup / stats / force_save / restart (reload
            from the persisted JSON) on a fake clock + _persist_load on malformed files
  fresh     signal_freshness.is_signal_fresh / get_current_price / tolerance (100 random tuples,
            random env) and momentum_veto.is_momentum_veto (100 random frames, random env)
  trend     trend_monitor: compute_trend / ribbon_strength on 30 synthetic frames x 6 TFs,
            refresh() sequences with REST throttling + restarts (kv round trip, NaN closes),
            apply_mtf_bonus x3 (idempotence, deepcopy) + the SMC grade (bot + D6), card_line
  free      free_report: 30 random sequences across day boundaries (windows, counters, missed /
            closed buffers, SMC preview dedup + quota, kv save / restart restore, evening report)
  cards     the bot's card renderers on fixtures/diff_card_signals.json (dumpDiffCardSignals.js)
            with random trend states, price scales, NaN fields, languages, users, keyboards
  repo      db/trades.py + signal_progress + trade_events + signals on the site's DDL
            (fixtures/trades_ddl.sql): random op sequences, the whole table after every step

Sequences are delta-encoded: every step carries `op` plus only the observed fields whose JSON
changed since the previous step (the first step starts from all-null); the test carries the
expected state forward. Non-finite floats are {"$f": "nan" | "inf" | "-inf"}.
"""
from __future__ import annotations

import asyncio
import copy
import importlib
import json
import logging
import math
import os
import random
import sqlite3
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "..", "fixtures")
sys.path.insert(0, os.getcwd())
sys.path.insert(0, HERE)

import database  # noqa: E402


def enc(x):
    if isinstance(x, float) and not math.isfinite(x):
        return {"$f": "nan" if math.isnan(x) else ("inf" if x > 0 else "-inf")}
    if isinstance(x, dict):
        return {str(k): enc(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [enc(v) for v in x]
    if isinstance(x, frozenset):
        return sorted(x)
    return x


def write(name, doc):
    with open(os.path.join(FIX, f"diff_{name}.json"), "w", encoding="utf-8") as fh:
        json.dump(enc(doc), fh, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        fh.write("\n")
    print("diff_" + name, "ok")


class Delta:
    """Per-step delta encoder: only the keys whose JSON changed since the previous step."""

    def __init__(self, keys):
        self.prev = {k: json.dumps(enc(None)) for k in keys}

    def __call__(self, op, full):
        out = {"op": op}
        for k, v in full.items():
            s = json.dumps(enc(v), ensure_ascii=False, sort_keys=False)
            if s != self.prev.get(k):
                out[k] = v
                self.prev[k] = s
        return out


class Clock:
    def __init__(self, t):
        self.t = float(t)

    def time(self):
        return self.t


class Capture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.lines = []

    def emit(self, record):
        self.lines.append([record.levelname, record.getMessage()])


def capture(*names):
    cap = Capture()
    for name in names:
        lg = logging.getLogger(name)
        lg.setLevel(logging.DEBUG)
        lg.addHandler(cap)
        lg.propagate = False
    return cap


def make_df(rows):
    import pandas as pd
    idx = pd.to_datetime([1_700_000_000_000 + i * 900_000 for i in range(len(rows))], unit="ms")
    return pd.DataFrame(rows, columns=["open", "high", "low", "close", "volume"], index=idx)


def set_env(env, keys):
    for k in keys:
        os.environ.pop(k, None)
    os.environ.update(env)


# ── loads ──────────────────────────────────────────────────────────────────
def loads_vectors():
    cases = ["", " ", "null", "5", "-0", "-0.0", "1.5", "1e5", "1E-2", "01", "1.", ".5", "-", "-a", "--1", "+1", "NaN",
             "Infinity", "-Infinity", "nan", "true", "false", "nul", "tru", "[]", "[1,]", "[1 2]", "[1, 2", "{}", "{,}",
             '{"a"}', '{"a" 1}', '{"a": }', '{"a": 1,}', '{"a": 1 "b": 2}', '{"a": 1}x', '{"a": 1} ', '﻿{}', '"abc',
             '"a\\x"', '"a\\u12"', '"a\\u12G4"', '"a\\ud83d\\ude00"', '"\\ud83d"', '"a\tb"', '"a\nb"',
             '{"101": 1, "7": 2, "abc": 3, "7": 4}', '[1, [2, [3, {"x": NaN}]]]', '{"a": Infinity, "b": -Infinity}',
             '"ж\\u0436"', '\n\n  {"a":\n x}', '{"__proto__": 1}', '1 2', '[\n1,\n2\n,]', '" "', '{"a": [1.0, 2e0, -3]}',
             '123456789012345678', '1e400', '-1e-400', '"\\/\\b\\f\\n\\r\\t\\"\\\\"', '{"k": "ж"} ж', 'ж', '[1, 2]]', '{"a":1}}']
    rnd = random.Random(9)
    for _ in range(150):
        base = json.dumps({str(rnd.randrange(300)): [rnd.random(), rnd.choice([None, True, "xж", float("nan"), 3, -2.5e-9])]
                           for _ in range(rnd.randint(0, 5))})
        if rnd.random() < 0.5 and len(base) > 2:
            k = rnd.randrange(len(base))
            base = base[:k] + rnd.choice(["", ",", "}", "]", '"', "x", " ", "\\"]) + base[k + 1:]
        cases.append(base)

    def tag(x):   # ints and floats told apart, dict order kept
        if isinstance(x, float):
            if math.isnan(x):
                return {"$f": "nan"}
            if math.isinf(x):
                return {"$f": "inf" if x > 0 else "-inf"}
            return {"$float": repr(x)}
        if isinstance(x, int) and not isinstance(x, bool):
            return {"$int": str(x)}
        if isinstance(x, dict):
            return {"$dict": [[k, tag(v)] for k, v in x.items()]}
        if isinstance(x, list):
            return [tag(v) for v in x]
        return x
    out = []
    for c in cases:
        try:
            out.append({"in": c, "ok": tag(json.loads(c))})
        except json.JSONDecodeError as e:
            out.append({"in": c, "err": str(e)})
    with open(os.path.join(FIX, "diff_loads.json"), "w", encoding="utf-8") as fh:
        json.dump({"cases": out}, fh, ensure_ascii=True, separators=(",", ":"))   # lone surrogates → \\ud83d
        fh.write("\n")
    print("diff_loads ok")


# ── registry ───────────────────────────────────────────────────────────────
def registry_vectors():
    import signal_registry as sr
    cap = capture("CHM.SignalRegistry")
    clk = Clock(0)
    sr.time = clk
    tmp = tempfile.mkdtemp()
    path = os.path.join(tmp, "reg.json")
    sr._PERSIST_PATH = path
    syms = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "PEPE-USDT-SWAP"]
    strats = ["", "", "SMC", "VOLUME", "MULTI"]
    uids = [1, 2, 123]

    def rand_user(rnd):
        return dict(user_id=rnd.choice(uids + [555]), strategy=rnd.choice(["LEVELS", "SMC", "VOLUME", "", "bogus", "smc"]),
                    extra_strategies=rnd.choice(["", "SMC", "VOLUME", "LEVELS,SMC", "smc, volume", "SMC,VOLUME", "X"]),
                    sub_plan=rnd.choice(["free", "pro", "elite", "", "beginner"]))

    def rand_adv(rnd):
        r = rnd.random()
        if r < 0.2:
            return rnd.choice([0.0, 0.5, 1.0, 9.9, 10.0, 10.1])
        if r < 0.4:
            return rnd.choice([59.0, 60.0, 119.9, 120.0, 120.1, 1799.5, 1800.0, 1800.5])
        if r < 0.6:
            return rnd.choice([14399.0, 14399.75, 14400.0, 14400.25, 3600.0, 57600.0])
        if r < 0.8:
            return round(rnd.uniform(0, 3000), rnd.choice([0, 1, 2, 3]))
        return rnd.uniform(0, 20000)

    def gen_ops(rnd, n):
        ops = []
        for _ in range(n):
            k = rnd.random()
            uid, sym, d, st = rnd.choice(uids), rnd.choice(syms), rnd.choice(["LONG", "SHORT"]), rnd.choice(strats)
            if k < 0.18:
                ops.append(["advance", rand_adv(rnd)])
            elif k < 0.33:
                ops.append(["peek", uid, sym, d, st])
            elif k < 0.48:
                ops.append(["commit", uid, sym, d, st, rnd.choice([None, None, 60, 30, 59.9, 120, 3600, 14400, 57600, 57600.9, 100000, 0, -5, 3600.5])])
            elif k < 0.53:
                ops.append(["can_send", uid, sym, d, st])
            elif k < 0.59:
                ops.append(["peek_multi", rand_user(rnd), sym, d])
            elif k < 0.65:
                ops.append(["claim_multi", rand_user(rnd), sym, d, rnd.choice([120, 120, 60, 30, 300])])
            elif k < 0.70:
                ops.append(["commit_multi", rand_user(rnd), sym, d])
            elif k < 0.73:
                ops.append(["can_send_multi", rand_user(rnd), sym, d])
            elif k < 0.80:
                ops.append(["cooldown", uid, sym, d, rnd.choice([1800, 30, 60, 59.5, 90.5, 600, 14400, 99999, 0, 1800.75])])
            elif k < 0.84:
                ops.append(["clear", uid, sym, d])
            elif k < 0.87:
                ops.append(["cleanup"])
            elif k < 0.90:
                ops.append(["stats"])
            elif k < 0.93:
                ops.append(["force_save"])
            elif k < 0.97:
                ops.append(["restart"])
            else:
                ops.append(["reset_stats"])
        return ops

    def snap():
        return {"|".join(str(p) for p in k): v for k, v in sr._registry.items()}

    def persisted():
        if not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as fh:
            return fh.read()

    def reset_all():
        sr._registry.clear()
        sr._stats.update(allowed=0, blocked=0)
        sr._last_cleanup = 0.0
        sr._last_persist = 0.0
        if os.path.exists(path):
            os.remove(path)
        cap.lines.clear()

    seqs = []
    for si in range(40):
        rnd = random.Random(9000 + si)
        reset_all()
        t0 = rnd.choice([1_800_000_000.25, 1_790_000_000.0, 1_800_000_123.875, 1000.0 + rnd.random()])
        clk.t = t0
        delta = Delta(["now", "result", "registry", "persisted", "logs"])
        steps = []
        for op in gen_ops(rnd, rnd.randint(20, 60)):
            k = op[0]
            res = None
            ns = types.SimpleNamespace
            if k == "advance":
                clk.t += op[1]
            elif k == "peek":
                res = sr.peek_can_send(op[1], op[2], op[3], op[4])
            elif k == "commit":
                sr.commit_send(op[1], op[2], op[3], op[4], ttl_s=op[5])
            elif k == "can_send":
                res = sr.can_send(op[1], op[2], op[3], op[4])
            elif k == "peek_multi":
                res = sr.peek_can_send_multi(ns(**op[1]), op[2], op[3])
            elif k == "claim_multi":
                sr.claim_multi(ns(**op[1]), op[2], op[3], ttl_s=op[4])
            elif k == "commit_multi":
                sr.commit_send_multi(ns(**op[1]), op[2], op[3])
            elif k == "can_send_multi":
                res = sr.can_send_multi(ns(**op[1]), op[2], op[3])
            elif k == "cooldown":
                sr.apply_cooldown(op[1], op[2], op[3], cooldown_s=op[4])
            elif k == "clear":
                sr.clear_for_symbol(op[1], op[2], op[3])
            elif k == "cleanup":
                sr.cleanup()
            elif k == "stats":
                res = sr.get_stats()
            elif k == "force_save":
                res = sr.force_save()
            elif k == "reset_stats":
                sr.reset_stats()
            elif k == "restart":   # a new process: module state reset, then _persist_load()
                sr._registry.clear()
                sr._stats.update(allowed=0, blocked=0)
                sr._last_cleanup = 0.0
                sr._last_persist = 0.0
                sr._persist_load()
            steps.append(delta(op, {"now": clk.t, "result": res, "registry": snap(), "persisted": persisted(),
                                    "logs": [l for l in cap.lines if l[0] in ("INFO", "WARNING")]}))
            cap.lines.clear()
        seqs.append({"t0": t0, "steps": steps})

    loads = []
    for raw in ["", "null", "5", "\"x\"", "true", "1.5", '{"1|A|LONG": [1]}', '{"1|A|LONG": {"a":1}}',
                '{"1|A|LONG": NaN, "2|B|LONG": 1799999999.0}', '{"1|A|LONG": Infinity}', '{"1|A|LONG": "  1799999999.5  "}',
                '{"1|A|LONG": "1_799_999_999.5"}', '{"1|A|LONG": 1799999999, "1|A|LONG": 1799999990}',
                '{"1|A|LONG": 1799999999, "01|A|LONG": 1799999990}', '{"-0|A|LONG": 1799999999}',
                '{"1|A|LONG": 1799999999, "2|B|LONG": "x", "3|C|LONG": 1799999999}', '[]', '{"1|A|LONG": 1e400}',
                '{"9|A|LONG": 1799999999, "10|B|LONG": 1799999998, "3|C|LONG": 1799999997}', '{"1|A|LONG": 17999}x']:
        reset_all()
        clk.t = 1_800_000_000.0
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(raw)
        sr._persist_load()
        loads.append({"raw": raw, "now": clk.t, "registry": snap(), "logs": [l for l in cap.lines if l[0] in ("INFO", "WARNING")]})
    reset_all()
    write("registry", {"seqs": seqs, "loads": loads})


# ── freshness / momentum veto ──────────────────────────────────────────────
ENV_VALS = {
    "FRESHNESS_BASELINE_S": ["", "10", "0", "60.5", "abc", " 20 ", "1e1", "-5"],
    "FRESHNESS_TOLERANCE_STEP_PCT": ["", "0.01", "0.1", "0", "x", "1_0"],
    "FRESHNESS_TOLERANCE_MAX_PCT": ["", "0.002", "0.01", "0", "inf", "nan"],
    "SIGNAL_MAX_DRIFT_R": ["", "0", "1.0", "0.25", "2", "bad", "-1", " 0.75 "],
    "MOMENTUM_VETO_ENABLED": ["", "0", "1", "true", "off", "No", " ON ", "yes"],
    "MOMENTUM_VETO_ATR_MULT": ["", "0.3", "1.2", "0", "1_0", "nan", "x", "-0.5"],
    "MOMENTUM_VETO_VOL_MULT": ["", "1.1", "3", "0", "bad", "inf"],
    "MOMENTUM_VETO_LOOKBACK": ["", "1", "2", "5", "10", "0", "0.8", "x", " 4 "],
}
FKEYS = ["FRESHNESS_BASELINE_S", "FRESHNESS_TOLERANCE_STEP_PCT", "FRESHNESS_TOLERANCE_MAX_PCT", "SIGNAL_MAX_DRIFT_R"]
VKEYS = ["MOMENTUM_VETO_ENABLED", "MOMENTUM_VETO_ATR_MULT", "MOMENTUM_VETO_VOL_MULT", "MOMENTUM_VETO_LOOKBACK"]


def walk_rows(rnd, n, start, vol):
    rows, p = [], start
    for _ in range(n):
        o = p
        c = o * (1 + rnd.gauss(0, vol))
        h = max(o, c) * (1 + abs(rnd.gauss(0, vol / 2)))
        lo = min(o, c) * (1 - abs(rnd.gauss(0, vol / 2)))
        rows.append([o, h, lo, c, 1000 * (0.5 + rnd.random())])
        p = c
    return rows


def fresh_vectors():
    import signal_freshness as sf0
    import momentum_veto as mv0
    fcap = capture("CHM.SignalFreshness")
    frames_by_tf = {}

    async def fake_get_candles(symbol, tf):
        v = frames_by_tf.get(tf)
        return None if v is None else make_df(v)
    real_cache = sys.modules.get("cache")
    sys.modules["cache"] = types.SimpleNamespace(get_candles=fake_get_candles)

    def rand_env(rnd, keys):
        return {k: rnd.choice(ENV_VALS[k]) for k in keys if rnd.random() < 0.35}

    fresh = []
    for i in range(100):
        rnd = random.Random(500 + i)
        env = rand_env(rnd, FKEYS)
        set_env(env, FKEYS)
        sf = importlib.reload(sf0)
        sf.reset_cycle_ema_for_tests()
        reports = [[rnd.choice(["LEVELS", "levels", "SMC", "VOLUME", ""]),
                    rnd.choice([0, -1, 5.0, 31.0, 60.0, 130.0, 333.3, 1000.0, 2500.0, rnd.uniform(0, 800)])]
                   for _ in range(rnd.randint(0, 4))]
        for s, sec in reports:
            sf.report_cycle_time(s, sec)
        direction = rnd.choice(["LONG", "SHORT", "LONG", "SHORT", "long", "Short", "BOTH", ""])
        entry = rnd.choice([100.0, 0.00909, 64250.5, 1.2345, 0.0, -1.0, 3.0])
        up = direction.upper() == "LONG"
        risk = abs(entry) * rnd.choice([0.005, 0.01, 0.02, 0.05])
        sl = rnd.choice([entry - risk if up else entry + risk, 0.0, entry - risk if up else entry + risk, -1.0])
        tp1 = rnd.choice([entry + 2 * risk if up else entry - 2 * risk, entry + 1.5 * risk if up else entry - 1.5 * risk, 0.0])
        cur = rnd.choice([entry, sl, tp1, tp1 * 1.001, tp1 * 0.999, tp1 * 1.004, tp1 * 0.996, entry + 0.5 * risk, entry - 0.5 * risk,
                          entry + 0.51 * risk, entry - 0.49 * risk, entry * (1 + rnd.uniform(-0.05, 0.05))])
        frames_by_tf.clear()
        last = [[cur, cur, cur, cur, 1.0]]
        layout = rnd.choice(["15m", "1H", "4H", "none", "zero15", "nan15", "empty15", "neg1H"])
        if layout in ("15m", "1H", "4H"):
            frames_by_tf[layout] = last
        elif layout == "zero15":
            frames_by_tf.update({"15m": [[1, 1, 1, 0.0, 1]], "1H": last})
        elif layout == "nan15":
            frames_by_tf.update({"15m": [[1, 1, 1, float("nan"), 1]], "4H": last})
        elif layout == "empty15":
            frames_by_tf.update({"15m": [], "1H": last})
        elif layout == "neg1H":
            frames_by_tf.update({"1H": [[1, 1, 1, -3.0, 1]], "4H": last})
        strategy = rnd.choice(["LEVELS", "SMC", "VOLUME", "", "levels"])
        uid = rnd.choice([0, 42, 7107654772])
        sym = rnd.choice(["BTC-USDT-SWAP", "PEPE-USDT-SWAP"])
        price = asyncio.run(sf.get_current_price(sym))
        fcap.lines.clear()
        res = asyncio.run(sf.is_signal_fresh(symbol=sym, direction=direction, entry=entry, tp1=tp1, strategy=strategy, uid=uid, sl=sl))
        ema = sf.get_cycle_ema(strategy)
        fresh.append({"env": env, "reports": reports, "direction": direction, "entry": entry, "sl": sl, "tp1": tp1,
                      "frames": dict(frames_by_tf), "strategy": strategy, "uid": uid, "symbol": sym, "price": price,
                      "max_drift": sf.MAX_DRIFT_R, "ema": ema, "tol": sf.compute_tolerance_pct(ema), "fresh": res,
                      "logs": [l for l in fcap.lines if l[0] != "DEBUG"]})
    set_env({}, FKEYS)
    importlib.reload(sf0)
    if real_cache is not None:
        sys.modules["cache"] = real_cache

    veto = []
    for i in range(100):
        rnd = random.Random(700 + i)
        env = rand_env(rnd, VKEYS)
        set_env(env, VKEYS)
        mv = importlib.reload(mv0)
        n = rnd.choice([14, 18, 19, 20, 21, 22, 25, 30, 40, 60, rnd.randint(15, 80)])
        rows = walk_rows(rnd, n, rnd.choice([0.0123, 1.5, 50.0, 64000.0]), rnd.choice([0.002, 0.005, 0.01, 0.03]))
        kind = rnd.choice(["plain", "spike_dn", "spike_up", "spike_dn_vol", "spike_up_vol", "zero_vol", "flat", "nan", "zero_then"])
        if kind.startswith("spike") and n >= 4:
            mult = rnd.choice([0.004, 0.008, 0.015, 0.03]) * (-1 if "dn" in kind else 1)
            vm = rnd.choice([1.0, 1.4, 1.5, 1.6, 3.0]) if kind.endswith("vol") else 1.0
            for j in range(max(1, n - 3), n):
                o = rows[j - 1][3]
                c = o * (1 + mult)
                rows[j] = [o, max(o, c) * 1.001, min(o, c) * 0.999, c, rows[j][4] * vm]
        elif kind == "zero_vol":
            for r in rows[: max(0, n - 3)]:
                r[4] = 0.0
        elif kind == "flat":
            rows = [[10.0, 10.0, 10.0, 10.0, 100.0] for _ in range(n)]
        elif kind == "nan" and n > 6:
            rows[rnd.randrange(n)][rnd.randrange(5)] = float("nan")
        elif kind == "zero_then" and n > 6:
            rows[-1 - rnd.choice([1, 2, 3, 4, 5])][3] = 0.0
        direction = rnd.choice(["LONG", "SHORT", "LONG", "SHORT", "LONG", "SHORT", "long", "BOTH"])
        df = make_df(rows)
        veto.append({"env": env, "consts": {"ENABLED": mv._ENABLED, "ATR": mv._DEFAULT_ATR_MULT, "VOL": mv._DEFAULT_VOL_MULT,
                                            "LB": mv._DEFAULT_LOOKBACK},
                     "rows": rows, "direction": direction, "result": list(mv.is_momentum_veto(df, direction)),
                     "atr_pct": mv._compute_atr_pct(df)})
    set_env({}, VKEYS)
    importlib.reload(mv0)
    write("fresh", {"fresh": fresh, "veto": veto})


# ── trend monitor ──────────────────────────────────────────────────────────
TREND_ENV = ["TREND_REST_REFRESH_S", "TREND_MTF_BONUS", "TREND_STRONG_PCT", "TREND_STRONG_COUNTER_PENALTY",
             "TREND_MONITOR_INTERVAL_S", "TREND_NOTIFY_TFS", "TREND_MONITOR_ENABLED", "TREND_ALIGNED_NOTIFY", "TREND_CTX_RISK"]


def gen_trend_frame(rnd, n):
    kind = rnd.choice(["up", "down", "range", "flip_up", "flip_dn", "mixed", "flat", "regime"])
    p = rnd.choice([100.0, 0.0123, 64000.0])
    closes = []
    for i in range(n):
        if kind == "up":
            p *= 1 + 0.003 + rnd.gauss(0, 0.003)
        elif kind == "down":
            p *= 1 - 0.003 + rnd.gauss(0, 0.003)
        elif kind == "range":
            p = closes[0] * (1 + 0.01 * math.sin(i / 4.0)) if closes else p
        elif kind == "flip_up":
            p *= (1 + 0.003) if i < n - rnd.choice([1, 2, 3]) else rnd.choice([0.6, 0.9, 0.97])
        elif kind == "flip_dn":
            p *= (1 - 0.003) if i < n - rnd.choice([1, 2, 3]) else rnd.choice([1.6, 1.1, 1.03])
        elif kind == "mixed":
            p *= 1 + rnd.gauss(0, 0.01)
        elif kind == "regime":
            p *= 1 + (0.004 if (i // 40) % 2 == 0 else -0.004) + rnd.gauss(0, 0.002)
        closes.append(p)
    if rnd.random() < 0.12 and n > 3:
        closes[rnd.choice([n - 1, n - 2, rnd.randrange(n)])] = float("nan")
    rows, prev = [], closes[0]
    for c in closes:
        ok = c == c
        rows.append([prev, max(prev, c) * 1.001 if ok else prev, min(prev, c) * 0.999 if ok else prev, c, 1000.0])
        prev = c
    return rows


def trend_vectors():
    import quiet_hours
    import telegram_safe
    import trend_monitor as tm0
    cap = capture("CHM.TrendMonitor")

    def reload(env):
        set_env(env, TREND_ENV)
        return importlib.reload(tm0)

    rnd = random.Random(4242)
    lens = [25, 26, 40, 55, 56, 59, 60, 61, 80, 120, 205, 206, 207, 208, 230, 260]
    frames = [gen_trend_frame(rnd, rnd.choice(lens)) for _ in range(30)]
    tm = reload({})
    compute = []
    for fi, rows in enumerate(frames):
        df = make_df(rows)
        for tf in tm.TFS:
            for prev in [None, "LONG", "SHORT", "RANGE"]:
                compute.append([fi, tf, prev, tm.compute_trend(df, prev, tf)])
        for t in ["LONG", "SHORT", "RANGE", None]:
            compute.append([fi, "ribbon", t, tm.ribbon_strength(df, t)])

    kv = {"d": {}, "writes": []}

    async def kv_get(k):
        return kv["d"].get(k)

    async def kv_set(k, v):
        kv["d"][k] = v
        kv["writes"].append([k, v])

    async def kv_del(k):
        kv["d"].pop(k, None)

    async def kv_keys(p):
        return [k for k in kv["d"] if k.startswith(p)]
    database.db_kv_get, database.db_kv_set, database.db_kv_delete, database.db_kv_keys_with_prefix = kv_get, kv_set, kv_del, kv_keys
    users = [{"user_id": 11, "lang": "ru", "quiet_start": -1, "quiet_end": -1},
             {"user_id": 12, "lang": "en", "quiet_start": -1, "quiet_end": -1}, {"user_id": 14, "lang": None}]

    async def active_users():
        return users
    database.db_get_active_users = active_users
    sends = []

    async def fake_send(bot, uid, text, parse_mode=None, reply_markup=None, disable_notification=None, **kw):
        sends.append({"uid": uid, "text": text, "silent": disable_notification})
        return True
    telegram_safe.safe_send_message = fake_send

    seqs = []
    for si in range(8):
        r2 = random.Random(77 + si)
        env = {}
        if r2.random() < 0.4:
            env["TREND_STRONG_PCT"] = r2.choice(["50", "80", "0"])
        if r2.random() < 0.3:
            env["TREND_NOTIFY_TFS"] = r2.choice(["15m,1D", "", "4H"])
        if r2.random() < 0.3:
            env["TREND_ALIGNED_NOTIFY"] = r2.choice(["0", "1"])
        if r2.random() < 0.3:
            env["TREND_REST_REFRESH_S"] = r2.choice(["600", "100", ""])
        tm = reload(env)
        clk = Clock(1_800_000_000.0 + r2.random())
        t0 = clk.t
        tm.time = clk
        quiet_hours.time = clk

        async def no_sleep(*_a, **_k):
            return None
        tm.asyncio = types.SimpleNamespace(sleep=no_sleep)
        kv["d"].clear()
        kv["writes"].clear()
        init_kv = {}
        if r2.random() < 0.5:
            init_kv["trend_aligned_v1"] = json.dumps({"dir": r2.choice(["LONG", "SHORT", ""]), "since": 1.0})
        if r2.random() < 0.3:
            init_kv["trend_notify_off_12"] = "1"
        kv["d"].update(init_kv)
        ws, rest_store, rest_plan, rest_calls, cache_sets = {}, {}, {}, [], []

        async def get_candles(sym, tf):
            if tf in ws:
                return ws[tf]
            e = rest_store.get(tf)
            return e[0] if e and clk.t < e[1] else None

        async def set_candles(sym, tf, df, ttl_map):
            cache_sets.append([sym, tf, len(df), ttl_map])
            rest_store[tf] = (df, clk.t + list(ttl_map.values())[0])
        import cache as _cache
        _cache.get_candles, _cache.set_candles = get_candles, set_candles

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
                rows = frames[p]
                return make_df(rows[-limit:] if limit < len(rows) else rows)

        def fresh_state():
            tm._state.clear()
            tm._strength.clear()
            tm._rest_next.clear()
            tm._aligned.clear()
            tm._aligned.update({"dir": None, "since": 0.0, "loaded": False})
            tm._loaded = False
        fresh_state()
        asyncio.run(tm.load_state())
        delta = Delta(["t", "changes", "sends", "rest_calls", "cache_sets", "kv_writes", "get_all", "rest_next", "aligned", "logs"])
        steps = []
        for _ in range(14):
            op = "refresh" if r2.random() > 0.12 else "restart"
            adv = r2.choice([0, 30, 60, 120, 300, 299.5, 600, 1800, 3600])
            wsplan = {tf: r2.randrange(len(frames)) for tf in ("15m", "1H", "4H") if r2.random() < 0.85}
            rplan = {tf: r2.choice([r2.randrange(len(frames)), "none", "raise", "empty"]) for tf in ("1D", "1W", "1M") if r2.random() < 0.6}
            clk.t += adv
            ws.clear()
            for tf, fi in wsplan.items():
                ws[tf] = make_df(frames[fi])
            rest_plan.clear()
            rest_plan.update(rplan)
            del sends[:], rest_calls[:], cache_sets[:]
            kv["writes"].clear()
            cap.lines.clear()
            changes = []
            if op == "restart":   # a new process: in-memory state + REST cache gone, kv kept
                fresh_state()
                rest_store.clear()
                asyncio.run(tm.load_state())
            else:
                changes = asyncio.run(tm.refresh(bot=object(), fetcher=Fetcher()))
            steps.append(delta([op, adv, wsplan, rplan], {
                "t": clk.t, "changes": [list(c) for c in changes], "sends": list(sends), "rest_calls": list(rest_calls),
                "cache_sets": list(cache_sets), "kv_writes": [w for w in kv["writes"] if w[0] in ("trend_state_v1", "trend_aligned_v1")],
                "get_all": tm.get_all(), "rest_next": dict(tm._rest_next),
                "aligned": {"dir": tm._aligned.get("dir"), "since": tm._aligned.get("since"), "had_kv": tm._aligned.get("had_kv", False)},
                "logs": [l for l in cap.lines if l[0] in ("INFO", "WARNING")]}))
        seqs.append({"env": env, "users": users, "init_kv": init_kv, "t0": t0, "steps": steps})

    from smc.signal_builder import GRADES
    bonus = []
    r3 = random.Random(31337)
    for _ in range(120):
        env = {}
        if r3.random() < 0.3:
            env["TREND_MTF_BONUS"] = r3.choice(["0", "2", ""])
        if r3.random() < 0.3:
            env["TREND_STRONG_COUNTER_PENALTY"] = r3.choice(["0", "2", "3"])
        if r3.random() < 0.3:
            env["TREND_STRONG_PCT"] = r3.choice(["50", "90", "100"])
        tm = reload(env)
        tm._state.clear()
        tm._strength.clear()
        trends = {tf: r3.choice(["LONG", "SHORT", "RANGE", "LONG", "SHORT"]) for tf in tm.TFS if r3.random() < 0.85}
        strengths = {"15m": r3.choice([0, 50, 69, 70, 71, 85, 90, 100])} if r3.random() < 0.85 else {}
        for tf, t in trends.items():
            tm._state[tf] = {"trend": t, "since": 0.0, "price": 0.0}
        tm._strength.update(strengths)
        kind = r3.choice(["LEVELS", "SMC", "VOLUME"])
        d = r3.choice(["LONG", "SHORT", "LONG", "SHORT", "long", "short", ""])
        if kind == "SMC":
            sc = r3.choice([0, 1, 2, 3, 4, 5, 3.0, 4.5])
            init, attr, cap_ = {"direction": d, "score": sc, "grade": GRADES.get(int(sc), f"⚡ {int(sc)}/5")}, "score", 5
        elif kind == "LEVELS":
            init, attr, cap_ = {"direction": d, "quality": r3.choice([0, 1, 2, 5, 6, 7, 9, 10, 6.5, "7", None, 3.0])}, "quality", 10
        else:
            init, attr, cap_ = {"direction": d, "quality": r3.choice([1, 2, 3, 4, 5, 4.0])}, "quality", 5
        if r3.random() < 0.08:
            init["mtf_aligned"] = r3.choice([True, False])
        sig = types.SimpleNamespace(**init)
        runs = []
        for rep in range(3):
            if rep == 2:
                sig = copy.deepcopy(sig)   # LEVELS hands deep copies of one memo result to several users
            ok = tm.apply_mtf_bonus(sig, attr=attr, cap=cap_)
            bot_grade = d6_grade = getattr(sig, "grade", None)
            if attr == "score":
                penalised = (not ok) and getattr(sig, "strong_counter", False) and tm.STRONG_COUNTER_PENALTY > 0 and rep == 0
                if ok:   # smc/scanner: if apply_mtf_bonus(...): sig.grade = GRADES.get(int(sig.score), sig.grade)
                    sig.grade = GRADES.get(int(sig.score), sig.grade)
                bot_grade = sig.grade
                d6_grade = GRADES.get(int(sig.score), sig.grade) if (ok or penalised) else sig.grade   # D6: also after the penalty
                sig.grade = d6_grade
            runs.append({"ok": ok, "fields": {k: getattr(sig, k, None) for k in ("mtf_aligned", "strong_counter", "trend_ctx", attr)},
                         "bot_grade": bot_grade, "d6_grade": d6_grade,
                         "card_line": {l: tm.card_line(getattr(sig, "direction", ""), "1h", l) for l in ("ru", "en")}})
        dirn = getattr(sig, "direction", "")
        bonus.append({"env": env, "trends": trends, "strengths": strengths, "attr": attr, "cap": cap_, "init": init, "runs": runs,
                      "ctx": {"none": tm.trend_context(dirn), "tf": tm.trend_context(dirn, True, False),
                              "ff": tm.trend_context(dirn, False, False), "ft": tm.trend_context(dirn, False, True)}})
    # kv round trip of non-finite floats: a NaN last close is saved as NaN by json.dumps and
    # read back by json.loads (the state survives a restart)
    tm = reload({})
    nan_rows = gen_trend_frame(random.Random(5), 260)
    nan_rows[-1][3] = nan_rows[-2][3] = float("nan")   # two closed bars → a confirmed RANGE at price NaN
    loads = []
    raws = [json.dumps({"15m": {"trend": "RANGE", "since": 1800000000.5, "price": float("nan")},
                        "1H": {"trend": "LONG", "since": 2.0, "price": float("inf")}}),
            '{"4H": {"trend": "SHORT", "since": NaN, "price": -Infinity}, "1D": {"trend": "LONG"}}',
            '{"15m": {"trend": "LONG", "since": 5}} trailing', '{"1W": {"trend": "LONG", "price": "NaN"}}']
    for raw in raws:
        tm._state.clear()
        tm._loaded = False
        kv["d"].clear()
        kv["d"]["trend_state_v1"] = raw
        asyncio.run(tm.load_state())
        loads.append({"raw": raw, "state": {k: dict(v) for k, v in tm._state.items()}})
    aligned_loads = []
    for raw in ['{"dir": "LONG", "since": NaN}', '{"dir": "SHORT", "since": Infinity}', '{"dir": NaN}']:
        tm._aligned.clear()
        tm._aligned.update({"dir": None, "since": 0.0, "loaded": False})
        kv["d"].clear()
        kv["d"]["trend_aligned_v1"] = raw
        asyncio.run(tm._load_aligned())
        aligned_loads.append({"raw": raw, "aligned": {k: tm._aligned.get(k) for k in ("dir", "since", "had_kv")}})
    # refresh on a 15m frame whose last close is NaN (trend RANGE, price NaN) → kv → restart → load_state
    import cache as _cache
    nan_df = make_df(nan_rows)

    async def nan_candles(sym, tf):
        return nan_df if tf == "15m" else None
    _cache.get_candles = nan_candles
    tm._state.clear()
    tm._strength.clear()
    tm._rest_next.clear()
    tm._loaded = False
    tm._aligned.clear()
    tm._aligned.update({"dir": None, "since": 0.0, "loaded": False})
    kv["d"].clear()
    kv["writes"].clear()
    tm.time = Clock(1_800_000_000.25)
    changes = asyncio.run(tm.refresh(bot=None, now=1_800_000_000.25, fetcher=None))
    nan_refresh = {"changes": [list(c) for c in changes], "kv_writes": [w for w in kv["writes"] if w[0] == "trend_state_v1"]}
    tm._state.clear()
    tm._strength.clear()
    tm._loaded = False
    asyncio.run(tm.load_state())
    nan_refresh["after_restart"] = tm.get_all()
    write("trend", {"frames": frames, "compute": compute, "seqs": seqs, "bonus": bonus, "nan_rows": nan_rows,
                    "loads": loads, "aligned_loads": aligned_loads, "nan_refresh": nan_refresh})
    reload({})


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
    real_sleep = asyncio.sleep

    async def fake_sleep(s=0, *a, **k):
        await real_sleep(0)
    fr.asyncio = types.SimpleNamespace(sleep=fake_sleep, get_running_loop=asyncio.get_running_loop,
                                       get_event_loop=asyncio.get_event_loop, CancelledError=asyncio.CancelledError)
    kvd, writes = {}, []

    async def kv_get(k):
        return kvd.get(k)

    async def kv_set(k, v):
        kvd[k] = v
        writes.append([k, v])
    database.db_kv_get, database.db_kv_set = kv_get, kv_set
    fr.db = database
    cap = capture("CHM.FreeReport")
    fields = ["free_signals_date", "free_signals_morning", "free_signals_evening", "free_signals_night", "free_signals_today",
              "free_missed_today", "free_smc_preview_date", "free_smc_preview_today"]

    def new_user(uid, plan, lang):
        return types.SimpleNamespace(user_id=uid, sub_plan=plan, lang=lang, free_signals_date="", free_signals_morning=0,
                                     free_signals_evening=0, free_signals_night=0, free_signals_today=0, free_missed_today=0,
                                     free_smc_preview_date="", free_smc_preview_today=0)

    class Bot:
        def __init__(self):
            self.sent = []

        async def send_message(self, uid, text, parse_mode=None, **kw):
            self.sent.append([uid, text])

    class UM:
        def __init__(self, users):
            self.users = users

        async def all_users(self):
            return list(self.users.values())

    syms = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "1000PEPE-USDT-SWAP", "SOL-USDT"]
    uid_of = {"a": 101, "b": 102, "p": 103, "c": 104}

    def reset_module():
        fr._missed_buffer.clear()
        fr._missed_buffer_dirty = 0
        fr._closed_profitable.clear()
        fr._closed_dirty = 0
        fr._FREE_PREVIEW_SENT.clear()

    async def run_seq(rnd):
        reset_module()
        kvd.clear()
        writes.clear()
        day0 = datetime(2027, rnd.choice([1, 3, 12]), rnd.choice([1, 15, 28]), tzinfo=timezone.utc).timestamp()
        clk.t = day0 + rnd.choice([5, 6, 12, 13, 20, 21, 23]) * 3600 + rnd.choice([0, 59 * 60 + 59, 1800])
        start = clk.t
        lang_c = rnd.choice(["", "de", "ru"])
        users = {"a": new_user(101, "free", "ru"), "b": new_user(102, "free", "en"), "p": new_user(103, "pro", "ru"),
                 "c": new_user(104, "free", lang_c)}
        um, bot = UM(users), Bot()
        delta = Delta(["t", "result", "users", "writes", "sent", "logs", "missed", "closed", "preview"])
        steps = []
        for _ in range(rnd.randint(25, 60)):
            if rnd.random() < 0.22:
                adv = rnd.choice([60, 600, 1800, 3599, 3600, 3601, 7200, 6 * 3600, 86400, 86400 - 1, 30 * 3600, rnd.uniform(0, 40000)])
                clk.t += adv
                op = ["advance", adv]
            else:
                who = rnd.choice(["a", "b", "p", "c"])
                k = rnd.random()
                if k < 0.18:
                    op = ["should", who, rnd.choice([0, 2, 3, 4, 5, 6, 9, 4.5, 2.99])]
                elif k < 0.30:
                    op = ["record", who, rnd.choice(["", "", "morning", "evening", "night"])]
                elif k < 0.42:   # rr: the LEVELS scanner passes int 0 (SignalResult has no rr)
                    op = ["missed", who, rnd.choice(syms), rnd.choice(["LONG", "SHORT"]), rnd.randint(0, 10), rnd.choice([0, 1.5, 2.25])]
                elif k < 0.52:
                    op = ["closed", rnd.choice(syms), rnd.choice(["LONG", "SHORT"]), rnd.choice([1.5, -1.0, 0.0, 2.0, 0.75, 3.25, 0.05, 12.345])]
                elif k < 0.62:
                    op = ["already", who, rnd.choice(syms), rnd.choice(["LONG", "SHORT"])]
                elif k < 0.72:
                    op = ["mark", who, rnd.choice(syms), rnd.choice(["LONG", "SHORT"])]
                elif k < 0.82:
                    op = ["should_preview", who]
                elif k < 0.90:
                    op = ["record_preview", who]
                elif k < 0.95:
                    op = ["restart"]
                else:
                    op = ["report"]
            cap.lines.clear()
            writes.clear()
            bot.sent.clear()
            res = None
            kind = op[0]
            if kind == "should":
                res = await fr.should_send_free_signal(users[op[1]], op[2])
            elif kind == "record":
                fr.record_free_signal_sent(users[op[1]], op[2])
            elif kind == "missed":
                fr.record_missed_signal(users[op[1]], op[2], op[3], op[4], rr=op[5])
            elif kind == "closed":
                fr.record_closed_profitable(op[1], op[2], op[3])
            elif kind == "already":
                res = fr._free_preview_already_sent_today(uid_of[op[1]], op[2], op[3])
            elif kind == "mark":
                fr._mark_free_preview_sent(uid_of[op[1]], op[2], op[3])
            elif kind == "should_preview":
                res = await fr.should_send_free_smc_preview(users[op[1]])
            elif kind == "record_preview":
                fr.record_free_smc_preview_sent(users[op[1]])
            elif kind == "restart":   # a new process: buffers gone, load_persistent_buffers() from kv
                reset_module()
                await fr.load_persistent_buffers()
            elif kind == "report":
                await fr._send_evening_report(bot, um)
            for _ in range(3):
                await real_sleep(0)   # fire-and-forget kv saves
            steps.append(delta(op, {
                "t": clk.t, "result": res, "users": {k: {f: getattr(u, f, None) for f in fields} for k, u in users.items()},
                "writes": list(writes), "sent": list(bot.sent), "logs": [l for l in cap.lines],
                "missed": json.loads(json.dumps({str(k): v for k, v in fr._missed_buffer.items()})),
                "closed": json.loads(json.dumps(fr._closed_profitable)),
                "preview": {str(k): dict(v) for k, v in fr._FREE_PREVIEW_SENT.items()}}))
        return {"start": start, "lang_c": lang_c, "steps": steps}

    seqs = [asyncio.run(run_seq(random.Random(1000 + i))) for i in range(30)]
    write("free", {"seqs": seqs})


# ── cards ──────────────────────────────────────────────────────────────────
def cards_vectors():
    import gen_cards as G
    import i18n
    import scanner_mid
    import signal_confluence
    import signal_format
    import volume_scanner
    from indicator import SignalResult
    from smc import scanner as smc_scanner
    from smc.signal_builder import SMCSignalResult
    from volume_strategy import VolumeSignal
    from watermark import wm_inject

    with open(os.path.join(FIX, "diff_card_signals.json"), encoding="utf-8") as fh:
        src = json.load(fh)
    scales = [1.0, 1e-5, 0.0123, 1234.5, 98765.4, 3e-8, 10000.0 / 64000.0, 1.0]
    price_fields = {"levels": ["entry", "sl", "tp1", "tp2", "tp3"],
                    "smc": ["entry", "entry_low", "entry_high", "sl", "tp1", "tp2", "tp3"],
                    "volume": ["entry", "sl", "tp1", "tp2", "tp3"]}
    users = [{"user_id": 123456789, "smc_max_sl_pct": 5.0, "trade_risk_pct": 1.0, "trade_leverage": 10},
             {"user_id": 987654321012, "smc_max_sl_pct": 0.5, "trade_risk_pct": 2.5, "trade_leverage": 3, "trade_exchange": "bingx"},
             {"user_id": 42, "smc_max_sl_pct": "2", "trade_risk_pct": 0.75, "trade_leverage": 20},
             {"user_id": 7, "trade_risk_pct": None, "trade_leverage": 0}]
    bals = [None, 2500.0, 0.0, 87.5, 1234567.89]
    ctxs = ["", "aligned", "with", "counter", "strong_counter", "bogus"]
    langs = ["ru", "en", "de", ""]
    rnd = random.Random(2026)
    cases = {"levels": [], "smc": [], "volume": []}
    for strat in ("levels", "smc", "volume"):
        for idx, it in enumerate(src[strat]):
            for rep in range(3):
                sc_i = rnd.randrange(len(G.SCENARIOS))
                G.set_trend(G.SCENARIOS[sc_i])
                sd = it["signal"]
                k = rnd.choice(scales)
                mutation = {} if k == 1.0 else {f: sd[f] * k for f in price_fields[strat] if isinstance(sd.get(f), (int, float))}
                lang = rnd.choice(langs)
                user = dict(rnd.choice(users))
                bal = rnd.choice(bals)
                ctx = rnd.choice(ctxs)
                u = types.SimpleNamespace(**user)
                case = {"source": it["source"], "rep": rep, "scenario": sc_i, "lang": lang, "user": user, "balance": bal, "ctx": ctx, "out": {}}
                if strat == "levels":
                    r = rnd.random()
                    if r < 0.15:
                        mutation.update({"rsi": float("nan")})
                    elif r < 0.25:
                        mutation.update({"volume_ratio": float("inf"), "btc_corr": float("nan")})
                    elif r < 0.35:
                        mutation.update({"btc_corr": -0.999, "eth_corr": 0.65})
                    elif r < 0.45:
                        mutation.update({"quality": rnd.choice([0, 1, 10, 11, -1]), "is_counter_trend": True})
                    elif r < 0.55:
                        mutation.update({"reasons": [], "_sq_boosted": True, "risk_pct": 0.0})
                    elif r < 0.62:
                        mutation.update({"symbol": "1000PEPE-USDT-SWAP", "breakout_type": "<b>&'\"", "human_explanation": "a\nb & <c>"})
                    tf = rnd.choice(["1h", "15m", "4h", "30m", "1d", "1H", "2h", "1w", "1M", "", "5m"])
                    case["timeframe"] = tf
                    sig = G.apply(G.make(SignalResult, sd), copy.deepcopy(mutation))
                    full = scanner_mid.signal_text(sig, types.SimpleNamespace(timeframe=tf), lang)
                    lite = signal_format.format_signal_lite(symbol=sig.symbol, direction=sig.direction, quality=sig.quality, entry=sig.entry,
                                                            sl=sig.sl, tp1=sig.tp1, tp2=getattr(sig, "tp2", None), tp3=getattr(sig, "tp3", None),
                                                            strategy="LEVELS", lang=lang, quality_scale=10)
                    pl = asyncio.run(G.pos_line(u, sig.entry, sig.sl, lang, ctx, bal))
                    fund = rnd.choice(["", "📰 <b>BTC</b> спокойно"])
                    case["fund"] = fund
                    for kind, base in (("full", full), ("lite", lite)):   # scanner_mid._send: + position line + fundamentals, wm_inject
                        text = base + ("\n" + pl if pl else "")
                        if fund:
                            text += "\n━━━━━━━━━━━━━━━━━━━━\n" + i18n.t("fundamental_header", lang) + "\n" + fund + "\n"
                        case["out"][kind] = base
                        case["out"]["assembled_" + kind] = wm_inject(text, u.user_id)
                    case["pl"] = pl
                    flags = [rnd.random() < 0.5, rnd.random() < 0.5, rnd.random() < 0.5]
                    case["kb_flags"] = flags
                    case["out"]["kb"] = G.kb_rows(scanner_mid.signal_compact_keyboard(
                        f"{u.user_id}_{idx}{rep}", sig.symbol, show_trade_btn=flags[0], is_counter_trend=flags[1], is_auto_traded=flags[2], lang=lang))
                elif strat == "smc":
                    r = rnd.random()
                    if r < 0.2:
                        mutation.update({"mode_tag": ""})
                    elif r < 0.3:
                        mutation.update({"risk_pct": float("nan")})
                    elif r < 0.4:
                        mutation.update({"sl": sd["entry"]})
                    elif r < 0.5:
                        mutation.update({"narrative": "x <b>y</b> & z", "symbol": "A&B-USDT-SWAP"})
                    sig = G.apply(G.make(SMCSignalResult, sd), copy.deepcopy(mutation))
                    fund = rnd.choice(["", "📰 Новости: <b>спокойно</b>"])
                    case["fund"] = fund
                    signal_confluence.reset_for_tests()
                    others = rnd.choice([[], ["LEVELS"], ["LEVELS", "VOLUME"], ["VOLUME"], ["SMC"]])
                    for s in others:
                        signal_confluence.record_signal(sig.symbol, sig.direction, s, 3)
                    case["confluence_others"] = others
                    raw = smc_scanner._signal_text_smc(sig, fund, lang=lang)
                    q = getattr(sig, "score", None) or getattr(sig, "quality", None) or 0
                    lite = signal_format.format_signal_lite(symbol=sig.symbol, direction=sig.direction, quality=q, entry=sig.entry, sl=sig.sl,
                                                            tp1=sig.tp1, tp2=getattr(sig, "tp2", None), tp3=getattr(sig, "tp3", None),
                                                            strategy="SMC", lang=lang)
                    case["out"]["full"], case["out"]["lite"] = raw, lite
                    pl = asyncio.run(G.pos_line(u, sig.entry, sig.sl, lang, ctx, bal))
                    case["pl"] = pl
                    label = signal_confluence.get_confluence_label(sig.symbol, sig.direction, current_strategy="SMC")
                    case["label"] = label
                    for kind, base in (("assembled_full", raw), ("assembled_lite", lite)):
                        text = smc_scanner._maybe_append_smc_sl_warning(wm_inject(base, u.user_id), sig, u, lang)
                        if pl:
                            text += "\n" + pl
                        if label:
                            text = f"{label}\n{text}"
                        case["out"][kind] = text
                    flags = [rnd.random() < 0.5, rnd.random() < 0.5, rnd.choice(["", f"555_{idx}{rep}"])]
                    case["kb_flags"] = flags
                    case["out"]["kb"] = G.kb_rows(smc_scanner._smc_keyboard(sig.symbol, flags[2], show_trade_btn=flags[0],
                                                                           is_auto_traded=flags[1], lang=lang))
                else:
                    r = rnd.random()
                    if r < 0.2:
                        mutation.update({"squeeze": rnd.choice([1, 2, 3])})
                    elif r < 0.3:
                        mutation.update({"quality": rnd.choice([0, 6, 5.7, -2])})
                    elif r < 0.4:
                        mutation.update({"reasons": ["<a>", "b & c"], "htf_state": rnd.choice([-1, 0, 1])})
                    elif r < 0.5:
                        mutation.update({"symbol": "1000PEPE-USDT", "vol_ratio": float("nan")})
                    sig = G.apply(G.make(VolumeSignal, sd), copy.deepcopy(mutation))
                    full = volume_scanner.signal_text(sig, lang)
                    lite = signal_format.format_signal_lite(symbol=sig.symbol, direction=sig.direction, quality=int(sig.quality), entry=sig.entry,
                                                            sl=sig.sl, tp1=sig.tp1, tp2=sig.tp2, tp3=sig.tp3,
                                                            strategy=volume_scanner.STRATEGY_NAME, lang=lang)
                    pl = asyncio.run(G.pos_line(u, sig.entry, sig.sl, lang, ctx, bal))
                    case["pl"] = pl
                    for kind, base in (("full", full), ("lite", lite)):
                        case["out"][kind] = base
                        case["out"]["assembled_" + kind] = wm_inject(base + ("\n" + pl if pl else ""), u.user_id)
                    flags = [rnd.random() < 0.5, rnd.random() < 0.5]
                    case["kb_flags"] = flags
                    case["out"]["kb"] = G.kb_rows(scanner_mid.signal_compact_keyboard(f"9_vol_{idx}{rep}", sig.symbol, show_trade_btn=flags[0],
                                                                                    is_auto_traded=flags[1], lang=lang))
                case["idx"] = idx
                case["mutation"] = mutation
                cases[strat].append(case)
    write("cards", {"scenarios": G.SCENARIOS, "cases": cases})


# ── repo ───────────────────────────────────────────────────────────────────
def repo_vectors():
    from db import core, trades as dbt, signal_progress as sp, trade_events as te, signals as dbs
    clk = Clock(1_800_000_000.5)
    dbt.time = clk
    te._t = clk
    cap = capture("CHM.DB", "CHM.Database", "CHM.TradeEvents")
    with open(os.path.join(FIX, "trades_ddl.sql"), encoding="utf-8") as fh:
        ddl = fh.read()
    c0 = sqlite3.connect(":memory:")
    c0.executescript(ddl)
    text_cols = {r[1] for r in c0.execute("PRAGMA table_info(trades)") if "TEXT" in (r[2] or "").upper()}
    c0.close()
    allowed = sorted(dbt._ALLOWED_TRADE_COLS)
    results = ["TP1", "TP2", "TP3", "SL", "BE", "MANUAL", "TRAIL", "SKIP", "ORPHAN", "CANCELLED", "LIQUIDATED", "", "tp1"]
    states = ["PENDING", "PLACING", "OPEN", "CLOSING", "CLOSED", "FAILED", "WAT"]
    stages = ["", "ENTRY", "TP1", "TP2", "TP3", "SL", "BE", "EXPIRED", "MISSED"]

    def rand_val(rnd, col):
        # text columns also get ints (bound as INTEGER like a Python int → '3', not '3.0') and
        # non-integral floats; an integral Python *float* into TEXT ('3.0') has no JS twin
        if col in text_cols and col not in ("order_id", "result", "state", "progress_stage", "strategy", "direction", "symbol"):
            return rnd.choice(["x", "", "Отскок", "a" * 70, None, 3, 2.5, 101])
        if col in ("entry", "sl", "tp1", "tp2", "tp3", "entry_lo", "entry_hi", "original_sl", "rsi", "volume_ratio", "result_rr"):
            return rnd.choice([100.0, 98.5, 104.25, 0.0, 1e-7, 64000.5, None, 7])
        if col in ("created_at", "state_changed_at", "progress_ts"):
            return clk.t - rnd.choice([0, 100, 3600, 72 * 3600 + 5, 80 * 3600, 4 * 86400, 40 * 86400])
        if col in ("signal_msg_id", "tp_placed", "quality", "is_counter_trend", "mtf_aligned", "placement_attempts"):
            return rnd.choice([0, 1, 5, True, False, None, 101])
        if col == "order_id":
            return rnd.choice(["", "", "ex-1", None])
        if col == "result":
            return rnd.choice(["", "", "SKIP", "TP1"])
        if col == "state":
            return rnd.choice(["PENDING", "PENDING", "OPEN", "PLACING"])
        if col == "progress_stage":
            return rnd.choice([None, "", "ENTRY", "TP1", "TP3"])
        if col == "strategy":
            return rnd.choice(["LEVELS", "SMC", "VOLUME"])
        if col == "direction":
            return rnd.choice(["LONG", "SHORT"])
        if col == "symbol":
            return rnd.choice(["BTC-USDT-SWAP", "ETH-USDT-SWAP"])
        return rnd.choice(["x", "", "Отскок", "a" * 70, 3, 2.5, None])

    def all_rows(path):
        c = sqlite3.connect(path)
        c.row_factory = sqlite3.Row
        rows = [dict(r) for r in c.execute("SELECT * FROM trades ORDER BY trade_id")]
        ev = [dict(r) for r in c.execute("SELECT * FROM trade_events ORDER BY id")]
        c.close()
        return rows, ev

    async def run_seq(rnd, path, fixed=None):
        tids = [f"t{i}" for i in range(6)]
        uids = [7, 8]
        delta = Delta(["now", "result", "error", "rows", "events", "logs"])
        steps = []
        for si_ in range(len(fixed) if fixed else rnd.randint(40, 70)):
            k = rnd.random()
            tid = rnd.choice(tids + ["nope"])
            if fixed:
                op = fixed[si_]
            elif k < 0.20:
                d = {"symbol": rnd.choice(["BTC-USDT-SWAP", "ETH-USDT-SWAP"]), "direction": rnd.choice(["LONG", "SHORT"]),
                     "entry": 100.0, "sl": 98.0, "tp1": 104.0, "tp2": 106.0, "tp3": 109.0}
                for c in rnd.sample(allowed, rnd.randint(1, 12)):
                    v = rand_val(rnd, c)
                    if c in d and v is None and rnd.random() < 0.9:
                        continue
                    d[c] = v
                d.update({"trade_id": rnd.choice(tids), "user_id": rnd.choice(uids)})
                if rnd.random() < 0.4:
                    d["bogus_col"] = 1
                if rnd.random() < 0.1:
                    d = {"bogus": 1}
                for c in ("result", "state", "created_at"):
                    if c not in d and rnd.random() < 0.8:
                        d[c] = rand_val(rnd, c)
                if "result" in d and d["result"] is None:
                    d["result"] = ""
                op = ["add", d]
            elif k < 0.38:
                op = ["result", tid, rnd.choice(results), rnd.choice([0.0, 2.0, -1.0, 1.5, 3.0]), rnd.choice([None, None, 12.5, -3, "4.25"]),
                      rnd.choice([None, None, "not_delivered", "z" * 90]), rnd.random() < 0.3]
            elif k < 0.50:
                op = ["state", tid, rnd.choice(states), rnd.random() < 0.3,
                      rnd.choice([None, None, ["PENDING"], ["PENDING", "CLOSED"], ["OPEN", "CLOSING"], ["WAT"], []])]
            elif k < 0.55:
                op = ["note", tid, rnd.choice([None, "заметка " * 70, ""]), rnd.choice([None, "manual", "q" * 80])]
            elif k < 0.62:
                op = ["msg", tid, rnd.choice([0, 101, 102, "7"]), rnd.choice(["", "{}", "{\"html\": \"x\"}"])]
            elif k < 0.70:
                op = ["advance", tid, rnd.choice(stages), rnd.choice(stages[1:]), clk.t - rnd.choice([0, 10, 50])]
            elif k < 0.75:
                op = ["expire", tid, rnd.choice(stages), rnd.choice([0.42, -1.0, 2.0]), clk.t]
            elif k < 0.79:
                op = ["trackable", clk.t - rnd.choice([3600, 72 * 3600, 100 * 3600]), rnd.choice([3000, 1, 2])]
            elif k < 0.82:
                op = ["expire_cands", clk.t, rnd.choice([72 * 3600, 3600]), rnd.choice([86400.0, 10.0]), rnd.choice([500, 1])]
            elif k < 0.87:
                op = ["evt_add", tid, rnd.choice([te.EVT_NOTIFICATION_SENT, te.EVT_FILTER_BLOCK, ""]),
                      rnd.choice([{}, {"ok": True, "rr": 1.5, "n": 2, "t": "привет"}, {"x": None, "nested": {"a": [1, 2.5]}}, None])]
            elif k < 0.90:
                op = ["evt_get", tid, rnd.choice([200, 1])]
            elif k < 0.92:
                op = ["evt_gc", rnd.choice([30, 1, 0])]
            elif k < 0.94:
                op = ["ghost", rnd.choice(uids), rnd.choice([3, 30, 1])]
            elif k < 0.95:
                op = ["ghost_all", rnd.choice([3, 30])]
            elif k < 0.97:
                op = ["user_trades", rnd.choice(uids)]
            elif k < 0.985:
                op = ["tp", tid, rnd.choice([None, 107.5]), rnd.choice([None, 1.25])]
            else:
                adv = rnd.choice([10, 3600, 86400 * 2, 86400 * 31])
                clk.t += adv
                op = ["advance_clock", adv]
            cap.lines.clear()
            res, err = None, None
            try:
                kind = op[0]
                if kind == "add":
                    res = await dbt.db_add_trade(dict(op[1]))
                elif kind == "result":
                    res = await dbt.db_set_trade_result(op[1], op[2], op[3], closed_pnl_usd=op[4], skip_reason=op[5], allow_overwrite_skip=op[6])
                elif kind == "state":
                    res = await dbt.db_set_trade_state(op[1], op[2], bump_attempts=op[3], expected_from=None if op[4] is None else frozenset(op[4]))
                elif kind == "note":
                    res = await dbt.db_set_trade_note(op[1], note=op[2], skip_reason=op[3])
                elif kind == "msg":
                    res = await sp.db_set_signal_msg_id(op[1], op[2], op[3])
                elif kind == "advance":
                    res = await sp.db_advance_signal_progress(op[1], op[2], op[3], op[4])
                elif kind == "expire":
                    res = await sp.db_mark_signal_expired(op[1], op[2], op[3], op[4])
                elif kind == "trackable":
                    res = await sp.db_get_trackable_signals(op[1], limit=op[2])
                elif kind == "expire_cands":
                    res = await sp.db_get_expire_candidates(op[1], op[2], grace_s=op[3], limit=op[4])
                elif kind == "evt_add":
                    res = await te.db_add_trade_event(op[1], op[2], op[3])
                elif kind == "evt_get":
                    res = await te.db_get_trade_events(op[1], limit=op[2])
                elif kind == "evt_gc":
                    res = await te.gc_trade_events(op[1])
                elif kind == "ghost":
                    res = list(await dbt.db_cleanup_ghost_trades(op[1], max_age_days=op[2]))
                elif kind == "ghost_all":
                    res = list(await dbt.db_cleanup_ghost_trades_all(max_age_days=op[1]))
                elif kind == "user_trades":
                    res = await dbt.db_get_user_trades(op[1])
                elif kind == "tp":
                    res = await dbs.update_signal_tp(op[1], tp2=op[2], tp3=op[3])
            except Exception as e:  # noqa: BLE001
                err = type(e).__name__
            for _ in range(4):
                await asyncio.sleep(0)   # emit_bg event tasks
            rows, ev = all_rows(path)
            steps.append(delta(op, {"now": clk.t, "result": res, "error": err, "rows": rows, "events": ev,
                                    "logs": [l[1] for l in cap.lines if l[0] in ("INFO", "WARNING") and "Persistent write" not in l[1]]}))
        return steps

    base = {"symbol": "BTC-USDT-SWAP", "direction": "LONG", "entry": 100.0, "sl": 98.0, "tp1": 104.0, "tp2": 106.0, "tp3": 109.0}
    fixed = [   # [SKIP-AFTER-TP-PLACED]: a SKIP written over a trade whose TPs were placed
        ["add", {**base, "trade_id": "s1", "user_id": 7, "tp_placed": 1, "result": "", "state": "OPEN", "created_at": 1_800_000_000.0}],
        ["result", "s1", "SKIP", 0.0, None, "not_delivered", False],
        ["add", {**base, "trade_id": "s2", "user_id": 7, "tp_placed": 3, "result": "TP1", "state": "CLOSED", "created_at": 1_800_000_000.0,
                 "session": 7, "order_link_id": 123456789012, "signal_type": 2.5}],
        ["result", "s2", "SKIP", 0.0, None, None, True],
    ]
    seqs = []
    for si in range(9):
        rnd = random.Random(555 + si)
        clk.t = 1_800_000_000.5 + si
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, "repo.db")
        c0 = sqlite3.connect(path)
        c0.executescript(ddl)
        c0.commit()
        c0.close()
        core._db_path = path
        core._read_pool = None
        core._write_conn = None
        database._db_path = path
        t0 = clk.t

        async def go():
            st = await run_seq(rnd, path, fixed if si == 8 else None)
            await core.close_write_conn()
            return st
        seqs.append({"t0": t0, "steps": asyncio.run(go())})
    write("repo", {"seqs": seqs})


SECTIONS = {"loads": loads_vectors, "registry": registry_vectors, "fresh": fresh_vectors, "trend": trend_vectors,
            "free": free_vectors, "cards": cards_vectors, "repo": repo_vectors}


def main(argv):
    for n in (argv or list(SECTIONS)):
        SECTIONS[n]()


if __name__ == "__main__":
    main(sys.argv[1:])
