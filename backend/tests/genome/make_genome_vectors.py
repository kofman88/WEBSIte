"""make_genome_vectors.py — Python-computed vectors for the M16 genome port.

Every value in tests/genome/fixtures/*.json is produced by the bot's OWN code
(/home/user/MAIN_BOT/CHM_BREAKER_V4: genome.py, genome_ui.py, backtest.py, …), never typed by
hand. Re-run:

  VENV=/tmp/…/venv/bin/python        # the bot's pinned venv (numpy/pandas/scipy/aiosqlite)
  $VENV backend/tests/genome/make_genome_vectors.py [section …]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json

Sections (default: all): gene_space constraints operators fitness evaluate simulate backtests db
coins handlers optimizer

How the parity is made exact where Python and JS cannot share an RNG:
  * operators — `genome.random` is replaced by a shim drawing from mulberry32 with the same
    random()/randint()/choice()/sample() algorithms as services/genome/rng.js, so
    random_gene_value / random_genome / mutate / tournament_select / bayesian_mutate /
    _apply_cross_hint must return the very same genomes for the same seed. crossover is not
    covered (Python iterates a hash-ordered set).
  * Monte Carlo — the bot shuffles with random.Random(42); `random.Random` is wrapped to record
    every shuffled list, the p95 drawdown is taken from those lists and stored as `mc_p95_raw`;
    the JS test injects it (services/genome/fitness.js, opts.mcP95Dd). MC with the JS RNG is
    pinned separately (formula only, by design).
  * time — genome.time / optimizer.time are replaced by a frozen clock (NOW) so kv / row
    timestamps are deterministic.
"""
from __future__ import annotations

import asyncio
import copy
import json
import math
import os
import random as pyrandom
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pyenv  # noqa: E402  (pins env, chdir to the bot, sys.path)

import pandas as pd  # noqa: E402

import genome  # noqa: E402
import backtest  # noqa: E402

REAL_BT = backtest.Backtester
REAL_RANDOM = pyrandom.Random
REAL_GENOME_TIME = genome.time

NOW = 1_790_000_000.0          # frozen clock for the DB / kv sections
SECTIONS = sys.argv[1:] or ["gene_space", "constraints", "operators", "fitness", "evaluate", "simulate", "backtests", "db",
                           "coins", "handlers", "optimizer"]


class FrozenTime:
    """Stands in for the `time` module inside genome / optimizer: time() frozen, rest real."""

    def __init__(self, now):
        import time as _t
        self._t = _t
        self.now = now

    def time(self):
        return self.now

    def __getattr__(self, k):
        return getattr(self._t, k)


# ─────────────────────────────────────────────────────────────────────────────
# mulberry32 shim (== services/genome/rng.js)
# ─────────────────────────────────────────────────────────────────────────────

def _imul(a, b):
    return (a * b) & 0xFFFFFFFF


class Mulberry:
    def __init__(self, seed):
        self.a = seed & 0xFFFFFFFF

    def u32(self):
        self.a = (self.a + 0x6D2B79F5) & 0xFFFFFFFF
        t = self.a
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        return (t ^ (t >> 14)) & 0xFFFFFFFF

    # Python random API subset, same algorithms as rng.js
    def random(self):
        return self.u32() / 4294967296

    def randbelow(self, n):
        return int(self.random() * n)

    def randint(self, a, b):
        return a + self.randbelow(b - a + 1)

    def choice(self, seq):
        seq = list(seq)
        return seq[self.randbelow(len(seq))]

    def sample(self, population, k):
        pool = list(population)
        n = len(pool)
        out = []
        for i in range(k):
            j = i + self.randbelow(n - i)
            pool[i], pool[j] = pool[j], pool[i]
            out.append(pool[i])
        return out

    def shuffle(self, x):
        for i in range(len(x) - 1, 0, -1):
            j = self.randbelow(i + 1)
            x[i], x[j] = x[j], x[i]


def with_shim(seed, fn, *a, **kw):
    real = genome.random
    genome.random = Mulberry(seed)
    try:
        return fn(*a, **kw)
    finally:
        genome.random = real


OUT = {}


def emit(name, doc):
    path = pyenv.write_fixture(name, doc)
    print(f"wrote {path}", file=sys.stderr)


# ─────────────────────────────────────────────────────────────────────────────
# gene_space
# ─────────────────────────────────────────────────────────────────────────────

def section_gene_space():
    doc = {"space": genome.GENE_SPACE, "floats": {}, "constants": {}}
    for strat, space in genome.GENE_SPACE.items():
        for name, d in space.items():
            if d["type"] != "float":
                continue
            lo, hi, step = d["min"], d["max"], d.get("step", 0.1)
            n = max(1, int((hi - lo) / step))
            values = sorted({round(lo + k * step, 4) for k in range(n + 1)})
            doc["floats"][f"{strat}.{name}"] = {"n_steps": n, "values": values, "reachable_max": max(values)}
    c = doc["constants"]
    for k in ("POP_SIZE", "ELITE_FRACTION", "MUTATION_RATE", "TOURNAMENT_SIZE", "EVAL_TOP_N", "EVAL_DAYS",
              "EVAL_MIN_TRADES", "OOS_SPLIT", "FEE_ROUND_TRIP_PCT", "SLIPPAGE_PCT", "LIVE_PF_DISCOUNT",
              "STALE_RESET_AFTER_GENS", "MAX_STALE_RESETS", "FITNESS_DECAY_PER_DAY", "CROSS_STRATEGY_RATE",
              "DRIFT_THRESHOLD_WR", "DRIFT_MIN_TRADES", "PAPER_WR_THRESHOLD", "MIN_PAPER_VALIDATION_N",
              "LIVE_WR_DISCOUNT", "META_INTERVAL_GENS", "AUTO_APPLY_MIN_FITNESS", "AUTO_APPLY_MIN_WR",
              "AUTO_APPLY_MIN_PF", "AUTO_APPLY_MIN_TRADES", "EVOLUTION_INTERVAL", "INITIAL_DELAY"):
        c[k] = getattr(genome, k)
    c["STRATEGY_TFS"] = genome.STRATEGY_TFS
    c["DEFAULT_TF"] = genome.DEFAULT_TF
    lookups = []
    for s in ("LEVELS", "SMC", "VOLUME", "levels", "OTHER", ""):
        row = {"strategy": s, "eval_top_n": genome._eval_top_n(s), "eval_min_trades": genome._eval_min_trades(s),
               "oos_split": genome._oos_split(s), "days": {}}
        for tf in ("1m", "3m", "5m", "15m", "30m", "1h", "1H", "2h", "4h", "4H", "1d", "1D", "1w", ""):
            row["days"][tf] = genome._eval_days_for_tf(tf, s)
        lookups.append(row)
    doc["lookups"] = lookups
    doc["timeouts"] = {tf: genome._eval_timeout_for_tf(tf) for tf in ("1m", "5m", "15m", "30m", "1h", "4h", "1d", "", "15M")}
    doc["regime"] = {r if r is not None else "None": {"drift": genome._drift_threshold_for_regime(r),
                                                       "pf": genome._pf_threshold_for_regime(r),
                                                       "age": genome._age_window_days_for_regime(r)}
                     for r in ("trending_up", "trending_down", "ranging", "high_vol", "weird", "", None)}
    doc["tfs"] = {s: [genome.get_tfs(s), genome.get_default_tf(s)] for s in ("LEVELS", "SMC", "VOLUME", "levels", "X")}
    emit("gene_space.json", doc)


# ─────────────────────────────────────────────────────────────────────────────
# constraints: 200 raw genomes per strategy → _fix_constraints
# ─────────────────────────────────────────────────────────────────────────────

def _raw_value(rng, d):
    t = d["type"]
    if t == "float":
        # wider than the gene space to exercise every repair rule
        lo, hi = d["min"], d["max"]
        span = hi - lo
        return round(rng.uniform(lo - span * 0.3, hi + span * 0.3), rng.choice([1, 2, 4]))
    if t == "int":
        return rng.randint(d["min"] - 1, d["max"] + 1)
    if t == "choice":
        return rng.choice(d["values"])
    return rng.choice([True, False])


def section_constraints():
    rng = pyrandom.Random(20261008)
    cases = {}
    for strat, space in genome.GENE_SPACE.items():
        out = []
        for k in range(200):
            g = {}
            for name, d in space.items():
                if strat != "VOLUME" and name != "min_rr" and rng.random() < 0.06:
                    continue                      # missing keys → the .get() defaults
                g[name] = _raw_value(rng, d)
            if strat == "LEVELS" and rng.random() < 0.15:
                g["ema_fast"] = rng.choice([30, 50, 100, 120])     # ema_fast ≥ ema_slow branch
                if rng.random() < 0.5:
                    g["ema_slow"] = rng.choice([26, 50])
            if strat == "LEVELS" and rng.random() < 0.08:
                g["use_pattern"] = True
            if strat == "VOLUME":
                if rng.random() < 0.15:
                    g["ema_fast"] = 9; g["ema_slow"] = 21; g["use_pullback"] = True; g["pullback_tol_pct"] = 0.3
                if rng.random() < 0.2:
                    g["tp3_rr"] = 9.9
                if rng.random() < 0.1:
                    g["vol_mult"] = rng.choice([2.2, 2.3, 2.5]); g["min_quality"] = 4
                if rng.random() < 0.1:
                    g["climax_mult"] = 0.0        # `or 4.5` falsy branch
            if strat == "SMC" and rng.random() < 0.2:
                g["fvg_enabled"] = g["choch_enabled"] = g["ob_use_breaker"] = False
            fixed = genome._fix_constraints(dict(g), strat)
            out.append({"in": g, "in_json": genome.serialize_genome(g), "out": fixed,
                        "out_json": genome.serialize_genome(fixed)})
        cases[strat] = out
    emit("constraints.json", cases)


# ─────────────────────────────────────────────────────────────────────────────
# operators under the mulberry32 shim
# ─────────────────────────────────────────────────────────────────────────────

def _pop(strat, seed, n=9):
    r = Mulberry(seed)
    pop = []
    for k in range(n):
        g = with_shim(seed * 31 + k, genome.random_genome, strat)
        pop.append({"id": 100 + k, "genome": g, "fitness": round(r.random() * 3 - 0.5, 4) if k % 4 else 0.0,
                    "winrate": 50.0, "profit_factor": 1.5, "trades": 12, "created_at": NOW - 86400 * k})
    return pop


def section_operators():
    doc = {"random_gene_value": [], "random_genome": [], "mutate": [], "tournament": [], "bayesian": [],
           "cross_hint": [], "gene_value_valid": [], "decay": [], "meta": []}
    for strat, space in genome.GENE_SPACE.items():
        for name, d in space.items():
            for seed in (1, 2, 3, 77):
                vals = with_shim(seed, lambda: [genome.random_gene_value(d) for _ in range(25)])
                doc["random_gene_value"].append({"strategy": strat, "gene": name, "seed": seed, "values": vals})
        for seed in range(1, 21):
            doc["random_genome"].append({"strategy": strat, "seed": seed, "genome": with_shim(seed, genome.random_genome, strat)})
        pop = _pop(strat, 5)
        for seed in range(1, 16):
            base = pop[seed % len(pop)]["genome"]
            for rate in (0.0, 0.3, 0.9):
                doc["mutate"].append({"strategy": strat, "seed": seed, "rate": rate, "in": base,
                                      "out": with_shim(seed, genome.mutate, dict(base), strat, rate)})
        for seed in range(1, 31):
            sub = pop[: 1 + seed % len(pop)]
            w = with_shim(seed, genome.tournament_select, sub)
            doc["tournament"].append({"strategy": strat, "seed": seed, "population": sub, "winner_id": w.get("id")})
        for seed in range(1, 16):
            base = pop[seed % len(pop)]["genome"]
            size = 4 if seed % 5 == 0 else len(pop)       # < 6 → plain mutate
            doc["bayesian"].append({"strategy": strat, "seed": seed, "in": base, "population": pop[:size],
                                    "out": with_shim(seed, genome.bayesian_mutate, dict(base), strat, pop[:size])})
        for other in genome.GENE_SPACE:
            if other == strat:
                continue
            src = _pop(other, 9, 1)[0]["genome"]
            hint = {k: v for k, v in src.items() if k in space}
            hint_bad = dict(hint)
            for k in list(hint_bad)[:2]:
                hint_bad[k] = 999
            for h in (hint, hint_bad):
                child = pop[0]["genome"]
                doc["cross_hint"].append({"strategy": strat, "in": child, "hint": h,
                                          "out": with_shim(4, genome._apply_cross_hint, dict(child), h, strat)})
        for name, d in space.items():
            for v in (True, False, 0, 1, 2, 1.5, 0.2, 3.0, 99, -1, "sma", "1.5", None, 20, 26, 0.0):
                doc["gene_value_valid"].append({"strategy": strat, "gene": name, "value": v,
                                                "valid": genome._gene_value_valid(d, v)})
    real_time = genome.time
    genome.time = FrozenTime(NOW)
    try:
        for f in (0.0, 1.0, 2.3456, 5.0, -0.5):
            for age in (0, 0.5, 1, 7, 30, 44, 45, 60, 365, -3):
                doc["decay"].append({"fitness": f, "created_at": NOW - age * 86400, "now": NOW,
                                     "out": genome.apply_fitness_decay(f, NOW - age * 86400)})
    finally:
        genome.time = real_time
    rng = pyrandom.Random(7)
    for k in range(40):
        n = rng.randint(0, 7)
        hist = [{"generation": i + 1, "best_fitness": round(rng.uniform(0, 3), 3)} for i in range(n)]
        state_key_runs = rng.randint(1, 3)
        genome._meta_state.clear()
        outs = []
        for _ in range(state_key_runs):
            outs.append(copy.deepcopy(genome.meta_adapt("LEVELS", "1h", hist)))
        doc["meta"].append({"history": hist, "runs": state_key_runs, "outs": outs})
    genome._meta_state.clear()
    emit("operators.json", doc)


# ─────────────────────────────────────────────────────────────────────────────
# fitness: compute_fitness table, log1p, Wilson
# ─────────────────────────────────────────────────────────────────────────────

def wilson_verbatim(test_wr, test_total):
    # the inline block of genome.evaluate_genome, verbatim
    _z = 1.96
    _n = test_total
    _p = test_wr / 100
    if _n > 0:
        _denom = 1 + _z * _z / _n
        _center = (_p + _z * _z / (2 * _n)) / _denom
        _margin = _z * math.sqrt((_p * (1 - _p) + _z * _z / (4 * _n)) / _n) / _denom
        return [round(max(0, (_center - _margin)) * 100, 1), round(min(1, (_center + _margin)) * 100, 1)]
    return [0.0, 0.0]


def section_fitness():
    rng = pyrandom.Random(99)
    cases = []
    fixed = [(0, 1, 0, 0), (55, 1.5, 0, 0), (55, 1.5, -3, 0), (0.55, 1.5, 12, 0.5), (55.0, 1.5, 12, 1.0),
             (55.0, 1.5, 12, 1.0000001), (55.0, 1.5, 12, 1.5), (55.0, 1.5, 12, 20.0), (34.9, 2.0, 30, 3.0),
             (35.0, 2.0, 30, 3.0), (60, 1.19, 7, 0.2), (60, 1.2, 8, 0.2), (60, 12.0, 51, 0.0), (60, 10.0, 50, 0.0),
             (100, 10.0, 200, 5.0), (150, 3.0, 20, 2.0), (1.0, 3.0, 20, 2.0), (1.0000001, 3.0, 20, 2.0),
             (-5, 2.0, 10, 0), (45, -1.0, 10, 0), (45, 0.0, 10, 0), (50, 1.3, 1, 0.9), (50, 1.3, 2, 0.99),
             (70, 4.0, 15, -2.0), (40, float("inf"), 9, 0.5)]
    for wr, pf, n, dd in fixed:
        cases.append({"winrate": wr, "profit_factor": pf, "trades": n, "drawdown": dd,
                      "out": genome.compute_fitness(wr, pf, n, dd)})
    for _ in range(300):
        wr = rng.choice([rng.uniform(0, 1), rng.uniform(0, 100), round(rng.uniform(20, 80), 2)])
        pf = rng.choice([rng.uniform(0, 3), rng.uniform(0, 12), round(rng.uniform(0.5, 4), 2)])
        n = rng.randint(0, 120)
        dd = rng.choice([rng.uniform(0, 1), rng.uniform(0, 30), round(rng.uniform(0, 5), 2), 1.0])
        cases.append({"winrate": wr, "profit_factor": pf, "trades": n, "drawdown": dd,
                      "out": genome.compute_fitness(wr, pf, n, dd)})
    log1p = {str(n): math.log1p(n) for n in range(0, 2001)}
    wil = []
    for n in list(range(0, 61)) + [80, 100, 150, 200, 333]:
        for wins in sorted({0, n // 3, n // 2, n, max(0, n - 1), min(n, 1)}):
            wr = (wins / n * 100) if n > 0 else 0
            wil.append({"n": n, "wins": wins, "winrate": wr, "ci": wilson_verbatim(wr, n)})
    emit("fitness.json", {"compute_fitness": cases, "log1p": log1p, "wilson": wil})


# ─────────────────────────────────────────────────────────────────────────────
# evaluate_genome with a fake Backtester (50 synthetic trade lists)
# ─────────────────────────────────────────────────────────────────────────────

MC_RECORD = []


class RecRandom(pyrandom.Random):
    def shuffle(self, x):  # noqa: D401
        super().shuffle(x)
        MC_RECORD.append(list(x))


def _dd(xs):
    eq = pk = dd = 0.0
    for r in xs:
        eq += r
        if eq > pk:
            pk = eq
        if pk - eq > dd:
            dd = pk - eq
    return dd


def mc_p95_from_record():
    if not MC_RECORD:
        return None
    dds = sorted(_dd(x) for x in MC_RECORD)
    return dds[int(len(dds) * 0.95)]


class FakeResult:
    def __init__(self, d):
        self.total_trades = d["total_trades"]
        self.profit_factor = d["profit_factor"]
        self.trades = d["trades"]


class FakeBT:
    def __init__(self, strategy, params=None, silent=False, fast_mode=False):
        self.params = params

    def run_in_thread(self, coin, df, tf, days):
        if isinstance(df, dict) and df.get("raise"):
            raise ValueError("boom " + coin)
        return FakeResult(df) if df is not None else None

    async def close(self):
        return None


class FakeKV:
    def __init__(self):
        self.d = {}

    async def get(self, k):
        return self.d.get(k)

    async def set(self, k, v):
        self.d[k] = v


def _install_fake_db(kv):
    import database
    database.db_kv_get = kv.get
    database.db_kv_set = kv.set


def _restore_real_db():
    """Undo _install_fake_db: the DB-backed sections (db / handlers) run after evaluate /
    backtests in a default all-sections run and must see the real kv (volume_cfg, live baseline)."""
    import database
    from db import misc as _misc
    database.db_kv_get = _misc.db_kv_get
    database.db_kv_set = _misc.db_kv_set


async def _run_eval(strategy, genome_d, tf, preloaded, baseline, kv):
    MC_RECORD.clear()
    genome._eval_cache.clear()
    return await genome.evaluate_genome(strategy, genome_d, tf, _preloaded=preloaded, _live_wr_baseline=baseline)


def _synthetic_case(rng, k):
    strat = rng.choice(["LEVELS", "SMC", "VOLUME"])
    tf = rng.choice(["15m", "1h", "4h"])
    n_coins = rng.randint(1, 8)
    stamps = [f"2026-0{rng.randint(1, 9)}-{rng.randint(10, 28)} {rng.randint(10, 23)}:{rng.choice(['00', '15', '30'])}:00" for _ in range(40)]
    pre = {}
    for c in range(n_coins):
        n = rng.choice([0, 1, 2, 3, 5, 8, 13, rng.randint(0, 40)])
        trades = []
        for _ in range(n):
            rr = rng.choice([-1.143, -1.121, -0.215, 0.0, 0.0, 0.153, 0.42, 0.871, 1.204, 2.317,
                             round(rng.uniform(-1.3, 3.0), 3)])
            et = rng.choice(stamps)
            xt = rng.choice([rng.choice(stamps), rng.choice(stamps), ""])
            t = {"entry_time": et, "exit_time": xt, "rr_realized": rr, "result": "TP1" if rr > 0 else "SL"}
            if rng.random() < 0.04:
                t["rr_realized"] = None
            if rng.random() < 0.03:
                t["entry_time"] = ""; t["exit_time"] = ""
            trades.append(t)
        pf = rng.choice([float("inf"), round(rng.uniform(0.2, 4), 6), 0.0])
        pre[f"C{k:02d}{c}-USDT-SWAP"] = {"total_trades": n, "profit_factor": pf, "trades": trades}
    if k % 17 == 0:
        pre[f"ERR{k}-USDT-SWAP"] = {"raise": True, "total_trades": 0, "profit_factor": 0, "trades": []}
    baseline = rng.choice([None, None, 0.0, 30.0, 45.5, 60.0, 80.0])
    g = with_shim(k, genome.random_genome, strat)
    return strat, tf, g, pre, baseline


def section_evaluate():
    rng = REAL_RANDOM(424242)
    backtest.Backtester = FakeBT
    pyrandom.Random = RecRandom
    genome.time = FrozenTime(NOW)
    try:
        _section_evaluate(rng)
    finally:
        backtest.Backtester = REAL_BT
        pyrandom.Random = REAL_RANDOM
        genome.time = REAL_GENOME_TIME
        _restore_real_db()


def _section_evaluate(rng):
    kv = FakeKV()
    _install_fake_db(kv)
    cases = []
    for k in range(50):
        strat, tf, g, pre, baseline = _synthetic_case(rng, k)
        kv.d.clear()
        if k == 7:                       # an existing, younger, better coin champion (kept)
            for coin in pre:
                kv.d[f"genome_coin_champ_{strat}_{tf}_{coin}"] = json.dumps({"coin_fit": 0.9, "ts": NOW - 3600})
        if k == 8:
            for coin in pre:
                kv.d[f"genome_coin_champ_{strat}_{tf}_{coin}"] = "{not json"
        before = dict(kv.d)
        out = asyncio.run(_run_eval(strat, g, tf, pre, baseline, kv))
        writes = {kk: v for kk, v in kv.d.items() if before.get(kk) != v}
        cases.append({"strategy": strat, "tf": tf, "genome": g, "preloaded": pre, "baseline": baseline,
                      "out": out, "mc_p95_raw": mc_p95_from_record(), "kv_before": before, "kv_writes": writes})
    # empty preloaded / all coins zero → EMPTY-RESULTS; nothing in preloaded → falls to run_scan (not used)
    out = asyncio.run(_run_eval("SMC", {"min_rr": 2.0}, "1h", {"A-USDT-SWAP": {"total_trades": 0, "profit_factor": 0, "trades": []}}, None, kv))
    cases.append({"strategy": "SMC", "tf": "1h", "genome": {"min_rr": 2.0},
                  "preloaded": {"A-USDT-SWAP": {"total_trades": 0, "profit_factor": 0, "trades": []}},
                  "baseline": None, "out": out, "mc_p95_raw": None, "kv_before": {}, "kv_writes": {}})
    emit("evaluate_synthetic.json", {"now": NOW, "cases": cases})


# ─────────────────────────────────────────────────────────────────────────────
# _simulate_trade branch table
# ─────────────────────────────────────────────────────────────────────────────

def _df(bars, start_ms=1_760_000_000_000, step_ms=3_600_000):
    idx = pd.to_datetime([start_ms + i * step_ms for i in range(len(bars))], unit="ms")
    return pd.DataFrame({"open": [b[0] for b in bars], "high": [b[1] for b in bars], "low": [b[2] for b in bars],
                         "close": [b[3] for b in bars], "volume": [1.0] * len(bars)}, index=idx)


def _sim(bt, sig, df, i):
    t = bt._simulate_trade(sig, "SYN-USDT-SWAP", df, i)
    if t is None:
        return None
    d = dict(t.__dict__)
    d["_exit_idx"] = int(df.index.searchsorted(pd.Timestamp(t.exit_time)))
    return d


def section_simulate():
    rng = pyrandom.Random(5150)
    synth = []
    flat = [(100, 100.2, 99.8, 100)] * 3
    paths = {
        "sl_first_long": flat + [(100, 103, 97, 100)] + flat,
        "tp1_then_be_long": flat + [(100, 102.5, 99.9, 102)] + [(102, 102.1, 98.0, 98.5)] + flat,
        "ptp_chain_long": flat + [(100, 101.2, 99.9, 101)] + [(101, 101.8, 100.5, 101.5)] + [(101, 104.5, 100.6, 104)] + flat,
        "ptp_be_long": flat + [(100, 101.3, 99.9, 101)] + [(101, 101.1, 99.0, 99.5)] + flat,
        "tp3_gap_long": flat + [(100, 110, 99.95, 109)] + flat,
        "timeout_up": [(100, 100.3, 99.9, 100 + 0.01 * k) for k in range(130)],
        "timeout_end": [(100, 100.3, 99.9, 100.1)] * 20,
        "sl_first_short": flat + [(100, 103, 97, 100)] + flat,
        "tp_short": flat + [(100, 100.1, 97.5, 98)] + [(98, 98.2, 95.0, 95.5)] + flat,
        "ptp_be_short": flat + [(100, 100.1, 98.7, 99)] + [(99, 101.0, 98.9, 100.5)] + flat,
        "timeout_short": [(100, 100.3, 99.9, 100 - 0.01 * k) for k in range(130)],
    }
    sigs = [
        ("LONG", 100, 99, 101.5, 102.5, 104.0),
        ("LONG", 100, 99, 101.5, 102.5, 0),
        ("LONG", 100, 99, 101.5, 0, 0),
        ("LONG", 100, 99, 0, 0, 0),
        ("LONG", 100, 100, 101, 102, 103),
        ("LONG", 100, 98, 102, 104, 106),
        ("SHORT", 100, 101, 98.5, 97.5, 96.0),
        ("SHORT", 100, 101, 98.5, 97.5, 0),
        ("SHORT", 100, 101, 98.5, 0, 0),
        ("SHORT", 100, 102, 98, 96, 94),
        ("LONG", 0, 99, 101, 102, 103),
    ]
    params_variants = [
        {},
        {"partial_tp_enabled": False},
        {"partial_tp_move_sl": False},
        {"slippage_pct": 0},
        {"slippage_pct": 0.25, "partial_tp1_r": 0.8, "partial_tp1_pct": 50, "partial_tp2_r": 1.2, "partial_tp2_pct": 25},
    ]
    for pname, bars in paths.items():
        df = _df(bars)
        for sig_t in sigs:
            for pv in params_variants:
                for env_be in ("0", "1"):
                    os.environ["BACKTEST_DISABLE_BE_MOVE"] = env_be
                    bt = backtest.Backtester("LEVELS", params=dict(pv), silent=True, fast_mode=True)
                    sig = dict(zip(("direction", "entry", "sl", "tp1", "tp2", "tp3"), sig_t))
                    entry_i = 2 if pname != "timeout_end" else 15
                    synth.append({"path": pname, "sig": sig, "params": pv, "env_be": env_be,
                                  "i": entry_i, "trade": _sim(bt, sig, df, entry_i)})
    os.environ["BACKTEST_DISABLE_BE_MOVE"] = "0"
    golden = []
    for sym in ("BTC-USDT-SWAP", "SYNDN01-USDT-SWAP", "SYNLV01-USDT-SWAP"):
        df = pyenv.load_df(sym, "15m")
        n = len(df)
        for _ in range(40):
            i = rng.randint(200, n - 2)
            c = float(df["close"].iloc[i])
            a = float((df["high"] - df["low"]).iloc[max(0, i - 14):i + 1].mean())
            d = rng.choice(["LONG", "SHORT"])
            sgn = 1 if d == "LONG" else -1
            k_sl = rng.choice([0.5, 1.0, 1.5, 2.5])
            ks = sorted(rng.sample([0.6, 1.0, 1.4, 2.0, 2.8, 3.5, 5.0], 3))
            tp = [c + sgn * a * x for x in ks]
            mode = rng.choice(["all", "no_tp3", "tp1_only"])
            if mode != "all":
                tp[2] = 0
            if mode == "tp1_only":
                tp[1] = 0
            sig = {"direction": d, "entry": c, "sl": c - sgn * a * k_sl, "tp1": tp[0], "tp2": tp[1], "tp3": tp[2]}
            pv = rng.choice(params_variants)
            bt = backtest.Backtester("SMC", params=dict(pv), silent=True, fast_mode=True)
            golden.append({"symbol": sym, "tf": "15m", "i": i, "sig": sig, "params": pv, "trade": _sim(bt, sig, df, i)})
    emit("simulate.json", {"paths": paths, "start_ms": 1_760_000_000_000, "step_ms": 3_600_000,
                           "synthetic": synth, "golden": golden})


# ─────────────────────────────────────────────────────────────────────────────
# full backtests + evaluate_genome on 3 golden fixtures
# ─────────────────────────────────────────────────────────────────────────────

FIXED_GENOMES = {
    "LEVELS": {"min_rr": 1.4, "min_quality": 2, "vol_mult": 1.4, "vol_len": 14, "rsi_period": 10, "rsi_ob": 67,
               "rsi_os": 33, "use_rsi": True, "use_volume": False, "ema_fast": 9, "ema_slow": 100, "zone_pct": 0.8,
               "max_dist_pct": 1.9, "tp1_rr": 1.9, "tp2_rr": 2.7, "pivot_strength": 10, "cooldown_bars": 5},
    "SMC": {"min_rr": 1.5, "min_confirmations": 2, "sl_buffer_pct": 0.2, "ob_max_age": 80, "fvg_enabled": True,
            "choch_enabled": True, "ob_use_breaker": True, "sweep_close_req": False, "smc_pd_filter": True,
            "smc_retrace_depth": 0.2, "smc_vol_mult": 1.2, "smc_use_volume_filter": False},
    "VOLUME": {"ma_type": "ema", "ma_fast": 9, "ma_mid": 21, "ma_slow": 55, "ema_trend": 200, "cross_lookback": 2,
               "turn_period": 20, "turn_lookback": 5, "turn_slope_bars": 2, "bounce_tol_atr": 0.25,
               "bounce_vol_mult": 1.0, "vol_mult": 1.3, "vol_len": 20, "climax_mult": 4.5, "extension_atr": 2.5,
               "rsi_long_max": 70, "rsi_short_min": 30, "sl_atr_mult": 2.0, "swing_lookback": 10, "tp1_rr": 1.0,
               "tp2_rr": 2.0, "min_quality": 2, "tp3_rr": 3.0},
}
GOLDEN_COINS = ("BTC-USDT-SWAP", "SYNDN01-USDT-SWAP", "SYNLV01-USDT-SWAP")


def section_backtests():
    backtest.Backtester = REAL_BT
    pyrandom.Random = RecRandom
    genome.time = FrozenTime(NOW)
    try:
        _section_backtests()
    finally:
        pyrandom.Random = REAL_RANDOM
        genome.time = REAL_GENOME_TIME
        _restore_real_db()


def _section_backtests():
    kv = FakeKV()
    _install_fake_db(kv)
    runs = []
    evals = []
    for strat, g in FIXED_GENOMES.items():
        p = dict(g)
        p.setdefault("fee_pct", 0.12)
        p.setdefault("slippage_extra_pct", 0.10)
        pre = {}
        for sym in GOLDEN_COINS:
            df = pyenv.load_df(sym, "15m")
            pre[sym] = df
            bt = backtest.Backtester(strat, params=p, silent=True, fast_mode=True)
            r = bt.run_in_thread(sym, df, "15m", genome._eval_days_for_tf("15m", strat))
            runs.append({"strategy": strat, "symbol": sym, "tf": "15m", "genome": g, "result": r.__dict__})
            print(f"backtest {strat} {sym}: {r.total_trades} trades", file=sys.stderr)
        kv.d.clear()
        out = asyncio.run(_run_eval(strat, g, "15m", pre, None, kv))
        evals.append({"strategy": strat, "tf": "15m", "genome": g, "coins": list(GOLDEN_COINS), "out": out,
                      "mc_p95_raw": mc_p95_from_record(), "kv_writes": dict(kv.d)})
        print(f"evaluate {strat}: fitness={out.get('fitness')} trades={out.get('trades')}", file=sys.stderr)
    emit("backtests.json", {"now": NOW, "runs": runs, "evaluate": evals})


# ─────────────────────────────────────────────────────────────────────────────
# DB-backed: apply / auto-apply / user TFs / drift / paper / dashboard / gc
# ─────────────────────────────────────────────────────────────────────────────

LEVELS_COLS = ("min_rr", "min_quality", "vol_mult", "vol_len", "rsi_period", "rsi_ob", "rsi_os", "use_rsi",
               "use_volume", "ema_fast", "ema_slow", "zone_pct", "max_dist_pct", "tp1_rr", "tp2_rr",
               "pivot_strength", "cooldown_bars")
USER_COLS = ("genome_auto_apply", "strategy", "extra_strategies", "vol_timeframe", "timeframe", "long_tf", "short_tf",
             "long_active", "short_active", "active", "scan_mode", "smc_cfg") + LEVELS_COLS


async def _db_reset(db, cx):
    for t in ("users", "genome_population", "genome_history", "optimizer_params", "kv", "trades"):
        await cx.execute(f"DELETE FROM {t}")
    await cx.commit()
    try:
        import optimizer
        optimizer.cache._cache.clear()  # noqa: SLF001
    except Exception:
        pass


async def _insert_user(cx, uid, row):
    cols = ["user_id", "username"] + list(row.keys())
    await cx.execute(f"INSERT INTO users ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                     [uid, f"u{uid}"] + [int(v) if isinstance(v, bool) else v for v in row.values()])


async def _insert_pop(cx, strat, tf, gen, items):
    for it in items:
        await cx.execute(
            "INSERT INTO genome_population (strategy, timeframe, generation, genome_json, fitness, winrate, "
            "profit_factor, trades, drawdown, parent_a, parent_b, birth_type, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (strat, tf, gen, genome.serialize_genome(it["genome"]), it["fitness"], it["winrate"], it["profit_factor"],
             it["trades"], it.get("drawdown", 1.0), it.get("parent_a", 0), it.get("parent_b", 0),
             it.get("birth_type", "random"), it.get("created_at", NOW - 3600)))


async def _insert_hist(cx, strat, tf, rows):
    for h in rows:
        await cx.execute(
            "INSERT OR REPLACE INTO genome_history (strategy, timeframe, generation, best_fitness, avg_fitness, best_wr, "
            "best_pf, best_genome_json, pop_size, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (strat, tf, h["generation"], h["best_fitness"], h["avg_fitness"], h["best_wr"], h["best_pf"],
             genome.serialize_genome(h.get("best_genome", {})), h.get("pop_size", 10), h.get("created_at", NOW)))


async def _insert_trades(cx, strat, trades):
    for k, t in enumerate(trades):
        await cx.execute(
            "INSERT INTO trades (trade_id, user_id, symbol, direction, entry, sl, tp1, tp2, tp3, result, result_rr, "
            "created_at, strategy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (f"{strat}-{k}", 1, t.get("symbol", "BTC-USDT-SWAP"), t.get("direction", "LONG"), t["entry"], t["sl"],
             t["tp1"], t["tp2"], t.get("tp3", 0), t["result"], t["result_rr"], t["created_at"], strat))


async def _user_state(cx, uid):
    cx.row_factory = None
    async with cx.execute(f"SELECT {', '.join(USER_COLS)} FROM users WHERE user_id=?", (uid,)) as cur:
        r = await cur.fetchone()
    return dict(zip(USER_COLS, r)) if r else None


async def section_db_async(out):
    import aiosqlite
    import database as db
    import market_regime
    import optimizer
    tmpdir = tempfile.mkdtemp(prefix="genome_vec_", dir=os.environ.get("GENOME_VEC_TMP") or None)
    out["_tmpdir"] = tmpdir
    path = os.path.join(tmpdir, "bot.db")
    await db.init_db(path)
    genome.time = FrozenTime(NOW)
    optimizer.time = FrozenTime(NOW)
    regime_box = {"r": None}
    market_regime.get_cached_regime = lambda: regime_box["r"]

    rng = pyrandom.Random(31337)
    base_user = {"genome_auto_apply": 0, "strategy": "LEVELS", "extra_strategies": "", "vol_timeframe": "1h",
                 "timeframe": "1h", "long_tf": "1h", "short_tf": "1h", "long_active": 0, "short_active": 0,
                 "active": 1, "scan_mode": "both", "smc_cfg": "{}",
                 "min_rr": 2.0, "min_quality": 3, "vol_mult": 1.0, "vol_len": 20, "rsi_period": 14, "rsi_ob": 65,
                 "rsi_os": 35, "use_rsi": 1, "use_volume": 1, "ema_fast": 50, "ema_slow": 200, "zone_pct": 0.7,
                 "max_dist_pct": 1.5, "tp1_rr": 2.0, "tp2_rr": 3.0, "pivot_strength": 7, "cooldown_bars": 5}

    async with aiosqlite.connect(path) as cx:
        # ── apply_best_to_user ───────────────────────────────────────────────
        apply_cases = []
        smc_cfgs = ["{}", json.dumps({"tf_key": "1H", "min_rr": 2.0, "fvg_enabled": True, "ob_max_age": 60}),
                    __import__("user_manager").SMCUserCfg().to_json(), "not json", "[]"]
        vol_kvs = [None, json.dumps({"setup_cross": False, "use_htf": False, "vol_mult": 2.0}),
                   json.dumps({"setup_ribbon": False, "ma_type": "sma", "ma_fast": 10})]
        scenario = 0
        for strat in ("LEVELS", "SMC", "VOLUME"):
            space = genome.GENE_SPACE[strat]
            for variant in range(9):
                scenario += 1
                await _db_reset(db, cx)
                uid = 1000 + scenario
                user = dict(base_user)
                if strat == "LEVELS" and variant % 3 == 1:
                    for c in LEVELS_COLS[:6]:
                        user[c] = FIXED_GENOMES["LEVELS"][c] if not isinstance(FIXED_GENOMES["LEVELS"][c], bool) else int(FIXED_GENOMES["LEVELS"][c])
                if strat == "SMC":
                    user["smc_cfg"] = smc_cfgs[variant % len(smc_cfgs)]
                kv_init = vol_kvs[variant % len(vol_kvs)] if strat == "VOLUME" else None
                tf = genome.get_default_tf(strat) if variant < 6 else rng.choice(["15m", "4h"])
                items = []
                for k in range(rng.randint(2, 5)):
                    g = with_shim(scenario * 10 + k, genome.random_genome, strat)
                    if strat == "LEVELS" and variant % 3 == 1 and k == 0:
                        g = dict(FIXED_GENOMES["LEVELS"])
                    items.append({"genome": g, "fitness": round(rng.uniform(0.1, 3), 4), "winrate": round(rng.uniform(30, 70), 2),
                                  "profit_factor": round(rng.uniform(0.5, 3), 2), "trades": rng.randint(3, 60),
                                  "drawdown": round(rng.uniform(0, 5), 2)})
                kind = "ok"
                if variant == 6:
                    kind = "no_evolution"
                elif variant == 7:
                    kind = "fitness_zero"
                    for it in items:
                        it["fitness"] = 0.0
                elif variant == 8:
                    kind = "user_missing"
                if kind != "no_evolution":
                    await _insert_pop(cx, strat, tf, 3, items)
                if kind != "user_missing":
                    await _insert_user(cx, uid, user)
                if kv_init is not None:
                    await cx.execute("INSERT INTO kv (key, value) VALUES (?, ?)", (f"volume_cfg_{uid}", kv_init))
                await cx.commit()
                res = await genome.apply_best_to_user(uid, strat, tf if variant >= 6 or variant % 2 else None)
                cx.row_factory = None
                async with cx.execute("SELECT value FROM kv WHERE key=?", (f"volume_cfg_{uid}",)) as cur:
                    kvr = await cur.fetchone()
                apply_cases.append({
                    "strategy": strat, "tf": tf, "pass_tf": bool(variant >= 6 or variant % 2), "uid": uid, "kind": kind,
                    "user": None if kind == "user_missing" else user, "kv_init": kv_init, "population": items,
                    "generation": 3, "result": res, "user_after": await _user_state(cx, uid),
                    "kv_after": kvr[0] if kvr else None,
                })
        out["apply"] = apply_cases

        # ── _user_tfs_for_strategy ───────────────────────────────────────────
        tfc = []
        for _ in range(80):
            row = {"long_active": rng.choice([0, 1]), "short_active": rng.choice([0, 1]), "active": rng.choice([0, 1]),
                   "scan_mode": rng.choice(["both", "long", "", None]), "long_tf": rng.choice(["15m", "1h", "4H", "", None]),
                   "short_tf": rng.choice(["15m", "1h", "4h", ""]), "timeframe": rng.choice(["1h", "4h", "1D", ""]),
                   "smc_cfg": rng.choice(["{}", '{"tf_key": "15m"}', '{"tf_key": "4H"}', '{"tf_key": ""}', "bad", "[]", None])}
            for s in ("LEVELS", "SMC", "levels"):
                tfc.append({"row": row, "strategy": s, "out": sorted(genome._user_tfs_for_strategy(row, s))})
        out["user_tfs"] = tfc

        # ── _auto_apply_best_genome ──────────────────────────────────────────
        auto = []
        users = []
        for k in range(14):
            u = dict(base_user)
            u["genome_auto_apply"] = 1 if k % 5 else 0
            u["strategy"] = rng.choice(["LEVELS", "SMC", "VOLUME"])
            u["extra_strategies"] = rng.choice(["", "VOLUME", "SMC,VOLUME", "SMC"])
            u["vol_timeframe"] = rng.choice(["15m", "1h", "4h"])
            u["long_active"] = rng.choice([0, 1]); u["short_active"] = rng.choice([0, 1])
            u["long_tf"] = rng.choice(["15m", "1h", "4h"]); u["short_tf"] = rng.choice(["15m", "1h", "4h"])
            u["active"] = rng.choice([0, 1]); u["scan_mode"] = rng.choice(["both", "long"])
            u["timeframe"] = rng.choice(["15m", "1h", "4h"])
            u["smc_cfg"] = rng.choice(["{}", '{"tf_key": "15m"}', '{"tf_key": "4H"}', '{"tf_key": "1H"}'])
            users.append((2000 + k, u))
        bests = [
            ("ok", {"fitness": 0.8, "winrate": 55.0, "profit_factor": 1.6, "trades": 25}),
            ("low_fit", {"fitness": 0.49, "winrate": 55.0, "profit_factor": 1.6, "trades": 25}),
            ("low_wr", {"fitness": 0.8, "winrate": 49.9, "profit_factor": 1.6, "trades": 25}),
            ("low_pf", {"fitness": 0.8, "winrate": 55.0, "profit_factor": 1.29, "trades": 25}),
            ("low_n", {"fitness": 0.8, "winrate": 55.0, "profit_factor": 1.6, "trades": 19}),
            ("kill", {"fitness": 0.8, "winrate": 55.0, "profit_factor": 1.6, "trades": 25}),
        ]
        for strat in ("LEVELS", "SMC", "VOLUME"):
            for tf in ("15m", "1h", "4h"):
                for label, b in bests:
                    await _db_reset(db, cx)
                    for uid, u in users:
                        await _insert_user(cx, uid, u)
                    await cx.commit()
                    best = dict(b)
                    best["genome"] = with_shim(len(auto) + 1, genome.random_genome, strat)
                    os.environ["GENOME_AUTO_APPLY_ENABLED"] = "0" if label == "kill" else "1"
                    await genome._auto_apply_best_genome(strat, tf, best)
                    os.environ["GENOME_AUTO_APPLY_ENABLED"] = "1"
                    cx.row_factory = None
                    async with cx.execute("SELECT user_id, strategy, params, updated_at FROM optimizer_params ORDER BY user_id, strategy") as cur:
                        op = [list(r) for r in await cur.fetchall()]
                    async with cx.execute("SELECT key, value FROM kv WHERE key LIKE 'volume_cfg_%' ORDER BY key") as cur:
                        vk = [list(r) for r in await cur.fetchall()]
                    auto.append({"strategy": strat, "tf": tf, "label": label, "best": best, "optimizer_params": op, "volume_kv": vk})
        out["auto_apply"] = {"users": [[uid, u] for uid, u in users], "cases": auto}

        # ── check_drift / validate_via_paper ─────────────────────────────────
        drift = []
        paper = []
        for k in range(60):
            await _db_reset(db, cx)
            strat = ["LEVELS", "SMC", "VOLUME"][k % 3]
            tf = "1h"
            regime_box["r"] = [None, "trending_up", "ranging", "high_vol", "trending_down", "weird"][k % 6]
            n_tr = [0, 10, 14, 15, 29, 30, 31, 60, 120, 220][k % 10] if k != 5 else 80
            trades = []
            for j in range(n_tr):
                e = 100.0 + rng.uniform(-5, 5)
                d = rng.choice(["LONG", "SHORT"])
                sgn = 1 if d == "LONG" else -1
                risk = rng.uniform(0.5, 2.0)
                p_win = [0.15, 0.35, 0.5, 0.7, 0.9][(k // 3) % 5]
                if rng.random() < p_win:
                    res = rng.choice(["TP1", "TP2", "TP3", "MANUAL"])
                else:
                    res = rng.choice(["SL", "SL", "BE", "MANUAL", "OPEN", ""])
                rr = {"TP1": 1.0, "TP2": 2.0, "TP3": 3.0, "SL": -1.0, "BE": 0.0}.get(res, round(rng.uniform(-1.2, 1.5), 3))
                if res == "SL" and rng.random() < 0.3:
                    rr = round(rng.uniform(-1.3, -0.8), 3)
                if k == 5 and j == 3:
                    res, rr = "SL", None          # result_rr NULL → validate_via_paper float(None) → ERROR
                trades.append({"direction": d, "entry": e if rng.random() > 0.03 else 0, "sl": e - sgn * risk,
                               "tp1": e + sgn * risk * rng.choice([0.8, 1.0, 1.5, 2.2]),
                               "tp2": rng.choice([0, e + sgn * risk * rng.choice([1.5, 2.0, 3.0])]),
                               "result": res, "result_rr": rr,
                               "created_at": NOW - rng.uniform(0, [16, 4, 2.5][k % 3]) * 86400})
            await _insert_trades(cx, strat, trades)
            gen_items = [{"genome": with_shim(k, genome.random_genome, strat), "fitness": 1.0 + j * 0.1,
                          "winrate": round(rng.uniform(30, 90), 2), "profit_factor": 1.5,
                          "trades": rng.choice([3, 5, 20, 40])} for j in range(3)]
            if k % 7 != 6:
                await _insert_pop(cx, strat, tf, 2, gen_items)
            await cx.commit()
            d_out = await genome.check_drift(strat, tf)
            drift.append({"strategy": strat, "tf": tf, "regime": regime_box["r"], "trades": trades,
                          "population": gen_items if k % 7 != 6 else [], "out": d_out})
            for gvar in ({"min_rr": 1.0}, {"min_rr": 1.6}, {}, {"min_rr": None}, {"min_rr": 2.5}):
                genome._last_paper_regime.clear()
                if k % 4 == 1:
                    genome._last_paper_regime[strat] = "trending_up"
                prev = dict(genome._last_paper_regime)
                cx.row_factory = None
                await cx.execute("DELETE FROM kv")
                await cx.commit()
                p_out = await genome.validate_via_paper(gvar, strat, tf)
                async with cx.execute("SELECT key, value FROM kv") as cur:
                    kvs = [list(r) for r in await cur.fetchall()]
                paper.append({"strategy": strat, "tf": tf, "regime": regime_box["r"], "genome": gvar, "trade_set": k,
                              "prev_regime": prev, "out": p_out, "kv": kvs})
        out["drift"] = drift
        out["paper"] = paper
        regime_box["r"] = None

        # ── dashboard texts ──────────────────────────────────────────────────
        dash = []
        for k, (strat, tf) in enumerate([("LEVELS", "1h"), ("SMC", "15m"), ("VOLUME", "4h"), ("levels", "2h"),
                                         ("XXX", "1h"), ("SMC", "1h"), ("VOLUME", "1h")]):
            await _db_reset(db, cx)
            S = strat.upper() if strat.upper() in genome.GENE_SPACE else "LEVELS"
            T = tf if tf in genome.get_tfs(S) else genome.get_default_tf(S)
            pop, hist = [], []
            if k != 4:
                for j in range(rng.randint(1, 10)):
                    g = with_shim(k * 100 + j, genome.random_genome, S)
                    pop.append({"genome": g, "fitness": round(rng.uniform(0, 3), 4), "winrate": round(rng.uniform(20, 80), 2),
                                "profit_factor": round(rng.uniform(0.2, 4), 2), "trades": rng.randint(0, 80),
                                "drawdown": round(rng.uniform(0, 9), 2), "parent_a": rng.choice([0, 0, 11]),
                                "parent_b": rng.choice([0, 12]),
                                "birth_type": rng.choice(["random", "elite", "crossover", "mutation", "bayesian_mut", "cross_strategy", ""])})
                await _insert_pop(cx, S, T, 4, pop)
                cx.row_factory = None
                async with cx.execute("SELECT id FROM genome_population WHERE strategy=? AND timeframe=? AND generation=4 ORDER BY id", (S, T)) as cur:
                    for it, r in zip(pop, await cur.fetchall()):
                        it["id"] = r[0]
                for gnum in range(1, rng.choice([1, 2, 5, 17]) + 1):
                    hist.append({"generation": gnum, "best_fitness": round(rng.uniform(0, 3), 4) if k != 5 else 0.0,
                                 "avg_fitness": round(rng.uniform(0, 1.5), 4), "best_wr": 50.0, "best_pf": 1.5})
                await _insert_hist(cx, S, T, hist)
            await cx.commit()
            import genome_ui
            text = await genome_ui.format_genome_dashboard(strat, tf)
            dash.append({"strategy": strat, "tf": tf, "S": S, "T": T, "population": pop, "history": hist, "text": text})
        import genome_ui
        out["dashboard"] = dash
        out["help"] = genome_ui.format_genome_help()

        # ── gc_coin_champions ────────────────────────────────────────────────
        await _db_reset(db, cx)
        gc_keys = []
        for j in range(230):
            age = rng.choice([1, 5, 29, 31, 60]) * 86400 + rng.uniform(0, 3600)
            val = json.dumps({"coin_fit": 0.0, "ts": NOW - age}) if j % 23 else "garbage"
            gc_keys.append([f"genome_coin_champ_LEVELS_1h_C{j:03d}-USDT-SWAP", val])
            await cx.execute("INSERT INTO kv (key, value) VALUES (?, ?)", gc_keys[-1])
        await cx.commit()
        gc_out = await genome.gc_coin_champions()
        cx.row_factory = None
        async with cx.execute("SELECT key FROM kv WHERE key LIKE 'genome_coin_champ_%' ORDER BY key") as cur:
            left = [r[0] for r in await cur.fetchall()]
        out["gc"] = {"keys": gc_keys, "out": gc_out, "remaining_keys": left}


def section_db():
    import shutil
    out = {"now": NOW}
    try:
        asyncio.run(section_db_async(out))
    finally:
        shutil.rmtree(out.pop("_tmpdir", ""), ignore_errors=True)
    emit("db_cases.json", out)


# ─────────────────────────────────────────────────────────────────────────────
# coin basket: _get_context_aware_coins with a fake HistoryLoader (golden candles)
# ─────────────────────────────────────────────────────────────────────────────

class FakeLoader:
    CANDIDATES = []
    TF = "1h"

    def __init__(self, *a, **k):
        pass

    async def get_top_coins(self, min_volume_usdt=5_000_000):
        return list(FakeLoader.CANDIDATES)

    async def load_cached(self, coin, tf, days):
        try:
            return pyenv.load_df(coin, tf)
        except FileNotFoundError:
            return None

    async def close(self):
        return None


class FakeResp:
    def __init__(self, status, data):
        self.status = status
        self._data = data

    async def json(self, content_type=None):
        return self._data

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class FakeSession:
    RESP = (200, [])

    def __init__(self, *a, **k):
        pass

    def get(self, url, params=None):
        FakeSession.LAST = (url, params)
        return FakeResp(*FakeSession.RESP)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def section_coins():
    import aiohttp
    real_hl = backtest.HistoryLoader
    real_session = aiohttp.ClientSession
    real_build = genome._build_tier_mixed_basket
    captured = {}

    async def capture_build(scored, limit, strategy, tf):
        captured["scored"] = [list(x) for x in scored]
        return await real_build(scored, limit, strategy, tf)

    golden = json.load(open(os.path.join(pyenv.GOLDEN_DIR, "candles", "index.json")))["fixtures"]
    symbols = [f["symbol"] for f in golden]
    rng = REAL_RANDOM(2718)
    cg_sets = [
        [{"id": i} for i in ["bitcoin", "ethereum", "cardano", "dogecoin", "kaspa", "unknown-x", "cardano", "the-graph"]],
        [{"id": "bitcoin"}],                    # nothing mappable → static fallback
        "not a list",
    ]
    out = {"cases": [], "tier2": []}
    aiohttp.ClientSession = FakeSession
    backtest.HistoryLoader = FakeLoader
    genome._build_tier_mixed_basket = capture_build
    try:
        for status, data in [(200, cg_sets[0]), (200, cg_sets[1]), (200, cg_sets[2]), (500, [])]:
            genome._TIER2_DYNAMIC_CACHE = (0.0, ())
            FakeSession.RESP = (status, data)
            res = asyncio.run(genome._get_tier2_dynamic())
            out["tier2"].append({"status": status, "data": data, "out": list(res)})
        FakeSession.RESP = (200, cg_sets[0])
        for k in range(12):
            strat = ["LEVELS", "SMC", "VOLUME"][k % 3]
            tf = ["1h", "15m", "4h"][k % 3]
            cands = rng.sample(symbols, rng.randint(5, len(symbols)))
            cands += rng.sample(["LAB-USDT-SWAP", "PENGU-USDT-SWAP", "SOL-USDT-SWAP", "ADA-USDT-SWAP", "DOGE-USDT-SWAP"], 3)
            rng.shuffle(cands)
            if k == 11:
                cands = []
            FakeLoader.CANDIDATES = cands
            genome._CONTEXT_COINS_CACHE.clear()
            genome._TIER2_DYNAMIC_CACHE = (0.0, ())
            captured.clear()
            limit = genome._eval_top_n(strat) if k % 4 else rng.choice([1, 2, 3, 5, 20])
            res = asyncio.run(genome._get_context_aware_coins(tf, strat, limit=limit))
            out["cases"].append({"strategy": strat, "tf": tf, "limit": limit, "candidates": cands,
                                 "scored": captured.get("scored"), "out": res,
                                 "tier2_pool": list(genome._TIER2_DYNAMIC_CACHE[1])})
    finally:
        aiohttp.ClientSession = real_session
        backtest.HistoryLoader = real_hl
        genome._build_tier_mixed_basket = real_build
    emit("coins.json", out)


# ─────────────────────────────────────────────────────────────────────────────
# handler texts: handlers/genome.py callbacks driven with fakes, i18n strings
# ─────────────────────────────────────────────────────────────────────────────

class _FakeDP:
    def __init__(self):
        self.handlers = {}

    def callback_query(self, *filters):
        def deco(fn):
            self.handlers[fn.__name__] = fn
            return fn
        return deco


class _FakeUser:
    def __init__(self, uid, can=True, auto=False, lang="ru"):
        self.user_id = uid
        self._can = can
        self.genome_auto_apply = auto
        self.lang = lang

    def can(self, feature):
        return self._can


class _FakeUM:
    def __init__(self, user):
        self.user = user

    async def get_or_create(self, uid, *a, **k):
        return self.user

    async def save(self, user):
        return None


class _FakeMsg:
    def __init__(self, log):
        self.log = log

    async def answer(self, text, parse_mode=None, **k):
        self.log.append(("message", text, parse_mode))


class _FakeCB:
    def __init__(self, data, uid, log):
        self.data = data
        self.from_user = type("U", (), {"id": uid})()
        self.message = _FakeMsg(log)
        self.log = log

    async def answer(self, text=None, show_alert=False, **k):
        self.log.append(("answer", text, show_alert))


def section_handlers():
    import handlers.genome as hg
    import genome_ui
    import i18n
    out = {"i18n": {}, "evolve": [], "apply": [], "keyboards": []}
    for key in ("sub_genome_locked", "genome_auto_apply_btn_on", "genome_auto_apply_btn_off",
                "genome_auto_apply_disabled", "genome_auto_apply_enabled_warn", "btn_back"):
        out["i18n"][key] = {lang: i18n.t(key, lang) for lang in ("ru", "en")}

    async def fake_edit(cb, text=None, reply_markup=None):
        cb.log.append(("edit", text, [[(b.text, b.callback_data) for b in row] for row in reply_markup.inline_keyboard]))

    async def fake_dash(strategy="LEVELS", tf=""):
        return f"DASH {strategy}/{tf}"

    hg.safe_edit = fake_edit
    genome_ui.format_genome_dashboard = fake_dash
    evolve_results = [
        {"ok": True, "strategy": "SMC", "tf": "1h", "generation": 7, "best_fitness": 1.23456, "best_wr": 55.55, "best_pf": 1.6, "elapsed": 93.6},
        {"ok": True, "generation": 1, "best_fitness": 0, "best_wr": 0, "best_pf": 0, "elapsed": 0.4},
        {"ok": False, "error": "Эволюция уже идёт, подожди 1-3 мин"},
        {"ok": False},
    ]
    apply_results = [
        {"ok": True, "changed": {}, "fitness": 1.0, "winrate": 50.0, "pf": 1.5, "trades": 10},
        {"ok": True, "changed": {"use_rsi": 1, "min_rr": 2.4, "tp2_rr": 3.0, "smc_retrace_depth": 0.5, "ma_type": "ema", "fvg_enabled": True, "<x>": "a&b"},
         "fitness": 2.71828, "winrate": 61.25, "pf": 1.875, "trades": 33},
        {"ok": False, "error": "Apply error: 'list' object has no attribute 'get' <tag>"},
        {"ok": False},
    ]
    for res in evolve_results:
        log = []
        dp = _FakeDP()

        async def fake_trigger(strategy, tf=None, _r=res):
            return dict(_r)
        genome.trigger_evolution_now = fake_trigger
        hg.register_handlers(dp, None, _FakeUM(_FakeUser(42)))
        asyncio.run(dp.handlers["cb_genome_evolve"](_FakeCB("adv_g_ev_SMC_1h", 42, log)))
        out["evolve"].append({"result": res, "log": log})
    for res in apply_results:
        log = []
        dp = _FakeDP()

        async def fake_apply(uid, strategy, tf=None, _r=res):
            return dict(_r)
        genome.apply_best_to_user = fake_apply
        hg.register_handlers(dp, None, _FakeUM(_FakeUser(42)))
        asyncio.run(dp.handlers["cb_genome_apply"](_FakeCB("adv_g_ap_LEVELS_4h", 42, log)))
        out["apply"].append({"result": res, "log": log})
    for (strategy, tf, auto, lang) in [("LEVELS", "1h", False, "ru"), ("SMC", "15m", True, "en"), ("VOLUME", "4h", True, "ru")]:
        log = []
        dp = _FakeDP()
        hg.register_handlers(dp, None, _FakeUM(_FakeUser(42, auto=auto, lang=lang)))
        asyncio.run(dp.handlers["cb_genome_tf"](_FakeCB(f"adv_g_tf_{strategy}_{tf}", 42, log)))
        out["keyboards"].append({"strategy": strategy, "tf": tf, "auto": auto, "lang": lang, "log": log})
    log = []
    dp = _FakeDP()
    hg.register_handlers(dp, None, _FakeUM(_FakeUser(42, can=False, lang="en")))
    asyncio.run(dp.handlers["cb_genome_evolve"](_FakeCB("adv_g_ev_SMC_1h", 42, log)))
    out["locked"] = log
    emit("handlers.json", out)


# ─────────────────────────────────────────────────────────────────────────────
# optimizer — optimizer._normalize_regime / params_for_regime (the real functions) and the two
# scanner consumers of optimizer_params, copied verbatim from scanner_mid.py (_run_job, ШАГ 9)
# and smc/scanner.py (the per-user hoist + the per-signal filter); `load_params` = json.loads of
# the stored row, `get_cached_regime()` = the given regime ("__RAISE__" → raises).
# ─────────────────────────────────────────────────────────────────────────────

def _regime_or_raise(regime):
    if regime == "__RAISE__":
        raise RuntimeError("regime cache broken")
    return regime


def _levels_consume(flags, stored, regime, min_rr, min_quality):
    import optimizer as _o

    class _Cfg:
        pass
    cfg = _Cfg()
    cfg.min_rr = min_rr
    cfg.min_quality = min_quality
    err = None
    if flags.get("optimizer_enabled", False) or flags.get("genome_auto_apply", False):
        try:
            _opt = json.loads(stored) if stored else None
            if _opt:
                try:
                    _cur_regime = _regime_or_raise(regime)
                    _opt = _o.params_for_regime(_opt, _cur_regime) or _opt
                except Exception:
                    pass
            if _opt:
                if _opt.get("min_rr", 0) > 0:
                    cfg.min_rr = float(_opt["min_rr"])
                if _opt.get("min_quality", 0) > 0:
                    cfg.min_quality = max(cfg.min_quality, int(_opt["min_quality"]))
        except Exception as _oe:
            err = type(_oe).__name__
    return {"min_rr": cfg.min_rr, "min_quality": cfg.min_quality, "err": err}


def _smc_consume(flags, stored, regime):
    import optimizer as _o
    _u_min_rr_filter = 0.0
    _u_min_q_filter = 0
    err = None
    if flags.get("optimizer_enabled", False) or flags.get("genome_auto_apply", False):
        try:
            _opt = json.loads(stored) if stored else None
            if _opt:
                try:
                    _cur_regime = _regime_or_raise(regime)
                    _opt = _o.params_for_regime(_opt, _cur_regime) or _opt
                except Exception:
                    pass
                _u_min_rr_filter = float(_opt.get("min_rr", 0) or 0)
                _u_min_q_filter = int(_opt.get("min_quality", 0) or 0)
        except Exception as _oe:
            err = type(_oe).__name__
    return {"min_rr_filter": _u_min_rr_filter, "min_q_filter": _u_min_q_filter, "err": err}


def _smc_passes(uc, rr, score):
    _min_rr_smc = uc.get("min_rr_filter", 0.0)
    _min_q_smc = uc.get("min_q_filter", 0)
    if _min_rr_smc > 0 and rr < _min_rr_smc:
        return False
    if _min_q_smc > 0 and score < _min_q_smc:
        return False
    return True


def section_optimizer():
    import optimizer as _o
    out = {"normalize": [], "regime": [], "levels": [], "smc": [], "smc_pass": []}
    for v in (None, "", "  ", 0, 1, 0.0, True, False, "trending_up", "TRENDING_UP ", " Trend_Up",
              "uptrend", "trend_down", "downtrend", "range", "sideways", "volatile",
              "high_volatility", "high_vol", "ranging", "trending_down", "\tranging\n", "bull",
              "Trending-Up", "HIGH_VOL", [], ["ranging"]):
        out["normalize"].append([v, _o._normalize_regime(v)])

    base = {"min_rr": 2.0, "min_quality": 3, "_meta": {"v": 1}, "tp1_rr": 1.5}
    regmap = {"trending_up": {"min_rr": 3.0, "min_quality": 5}, "ranging": {"min_rr": 1.6},
              "high_vol": "not-a-dict", "trending_down": {}}
    bay = {"symbol": "BTC-USDT-SWAP", "params": {"min_rr": 2.2, "pivot_strength": 4}}
    params_list = [
        None, {}, [], "x", 0, [1, 2],
        {"min_rr": 2.0},
        dict(base),
        dict(base, _regime={}),
        dict(base, _regime=regmap),
        dict(base, _regime="nope"),
        dict(base, _bayesian=bay),
        dict(base, _bayesian={"params": {"min_quality": 4}}),
        dict(base, _bayesian={"params": "x", "symbol": "ETH"}),
        dict(base, _bayesian="x"),
        dict(base, _bayesian=bay, _regime=regmap),
        {"_regime": regmap},
        {"_bayesian": {"params": {}}},
        {"_regime": {"ranging": {"_active_regime": "zzz", "min_rr": 1.1}}},
        {"z": 1, "_regime": {"ranging": {"a": 2, "z": 3}}, "b": 4},
    ]
    regimes = [None, "", "trending_up", "uptrend", "ranging", "high_vol", "trending_down", "bull", "RANGE "]
    for p in params_list:
        for r in regimes:
            res = _o.params_for_regime(copy.deepcopy(p), r)
            out["regime"].append({"params": p, "regime": r, "out": res,
                                  "keys": list(res.keys()) if isinstance(res, dict) else None})

    stored_list = [
        None, "", "null", "{}", "[]", "[1]", "\"x\"", "3",
        json.dumps({"min_rr": 2.4, "min_quality": 4}),
        json.dumps({"min_rr": 2, "min_quality": 3.7}),
        json.dumps({"min_rr": 0, "min_quality": 0}),
        json.dumps({"min_rr": -1.5, "min_quality": -2}),
        json.dumps({"min_rr": None, "min_quality": 5}),
        json.dumps({"min_rr": 2.5, "min_quality": None}),
        json.dumps({"min_rr": "2.5", "min_quality": 5}),
        json.dumps({"min_rr": 2.5, "min_quality": "5"}),
        json.dumps({"min_rr": True, "min_quality": True}),
        json.dumps({"min_rr": False, "min_quality": False}),
        json.dumps({"min_rr": [1], "min_quality": 2}),
        json.dumps({"min_quality": 9}),
        json.dumps({"min_rr": 1e-9}),
        '{"min_rr": Infinity, "min_quality": 4}',
        '{"min_rr": 2.0, "min_quality": Infinity}',
        '{"min_rr": NaN, "min_quality": NaN}',
        json.dumps(dict(base, _regime=regmap)),
        json.dumps(dict(base, _bayesian=bay, _regime=regmap)),
        json.dumps({"_regime": {"trending_up": {"min_rr": 3.5, "min_quality": 6}}}),
        json.dumps({"_regime": {"ranging": {}}}),
        json.dumps({"min_rr": 2.0, "_regime": {"ranging": {"min_rr": "bad"}}}),
        json.dumps({"min_rr": 2.0, "min_quality": 2, "_regime": {"trending_up": {"min_quality": 8}}}),
    ]
    flag_sets = [{}, {"optimizer_enabled": True}, {"genome_auto_apply": True},
                 {"optimizer_enabled": 0, "genome_auto_apply": 1}]
    for stored in stored_list:
        for fl in flag_sets:
            for regime in (None, "trending_up", "__RAISE__", "range"):
                for (mr, mq) in ((1.8, 3), (2.6, 6)):
                    out["levels"].append({"flags": fl, "stored": stored, "regime": regime,
                                          "cfg": [mr, mq],
                                          "out": _levels_consume(fl, stored, regime, mr, mq)})
                out["smc"].append({"flags": fl, "stored": stored, "regime": regime,
                                   "out": _smc_consume(fl, stored, regime)})
    for uc in ({}, {"min_rr_filter": 0.0, "min_q_filter": 0}, {"min_rr_filter": 2.0, "min_q_filter": 0},
               {"min_rr_filter": 0.0, "min_q_filter": 4}, {"min_rr_filter": 2.0, "min_q_filter": 4},
               {"min_rr_filter": float("nan"), "min_q_filter": 0}, {"min_rr_filter": float("inf"), "min_q_filter": 1}):
        for (rr, score) in ((1.5, 3), (2.0, 4), (2.5, 5), (1.99, 4), (3.0, 3)):
            out["smc_pass"].append({"uc": uc, "rr": rr, "score": score, "out": _smc_passes(uc, rr, score)})
    emit("optimizer.json", out)


if __name__ == "__main__":
    for s in SECTIONS:
        print(f"== {s}", file=sys.stderr)
        globals()[f"section_{s}"]()
    sys.stderr.flush()
    sys.stdout.flush()
    os._exit(0)          # aiosqlite's pooled connection threads are not daemons — do not wait for them
