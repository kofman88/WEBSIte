"""make_genome_verify_vectors.py — the adversarial M16 verification vectors (fresh data, never
the inputs of make_genome_vectors.py), produced by the bot's OWN code
(/home/user/MAIN_BOT/CHM_BREAKER_V4). Re-run:

  VENV=/tmp/…/venv/bin/python        # the bot's pinned venv
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 $VENV backend/tests/genome/make_genome_verify_vectors.py [section …]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json

Sections (default: all) → fixtures/verify_<section>.json.gz:
  constraints  genome._fix_constraints on 500 fresh genomes per strategy: in-space draws,
               out-of-range / int↔float / bool-as-int values, missing keys (VOLUME refill under
               the mulberry32 shim, seed recorded), legacy keys, None values (Python exceptions
               recorded by type name)
  fitness      await genome.evaluate_genome(S, g, tf, _preloaded=fake results) on 200 trade lists
               (empty, all-BE, all-loss, single trade, min-trades edges, equal timestamps, ≥ 16 for
               walk-forward, > 50 / 175 / 184 trades, live baselines) — random.Random(42) recorded
               → mc_p95_raw; plus compute_fitness on 200 edge tuples
  backtests    Backtester(S, params=genome + fees, silent, fast).run_in_thread(sym, df, tf, days)
               on 6 golden fixtures (none of the 3 used by make_genome_vectors) × 3 strategies ×
               5 fixed genomes, and evaluate_genome over the 6 recorded results per genome
  wide         the same 5 genomes per strategy on 1h and 4h over 12 golden fixtures (run_in_thread)
  apply        await genome.apply_best_to_user(uid, S, tf) — 20 population scenarios per strategy
               (ties, fitness 0, trades < EVAL_MIN_TRADES on the best, legacy keys, user values
               equal as int/float/bool, smc_cfg literal kinds / unicode / non-dict, volume prefs)
  routes       miniapp_api.h_genome / h_genome_apply (the real handlers, _load_user patched) on
               seeded genome_history / kv rows
The bot repo is only read (sys.dont_write_bytecode; the temp SQLite dir is removed).
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import random as pyrandom
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_genome_vectors as mgv  # noqa: E402  (pyenv: env pinned, chdir to the bot, sys.path)
import pyenv  # noqa: E402

import genome  # noqa: E402
import backtest  # noqa: E402

NOW = mgv.NOW

# make_genome_vectors._install_fake_db patches database.db_kv_get / db_kv_set module-wide; the
# DB-backed sections below need the real ones back (state must not leak between sections).
_restore_kv = mgv._restore_real_db
SECTIONS = sys.argv[1:] or ["constraints", "fitness", "backtests", "wide", "apply", "routes"]


def emit(name, doc):
    path = pyenv.write_fixture(f"verify_{name}.json", doc)
    print(f"wrote {path}", file=sys.stderr)


# ─────────────────────────────────────────────────────────────────────────────
# constraints
# ─────────────────────────────────────────────────────────────────────────────

LEGACY = {
    "LEVELS": [("use_pattern", [True, False, 1, 0]), ("use_htf", [True, False]), ("tp3_rr", [3.0, 4.5]),
               ("max_level_age", [50, 100])],
    "SMC": [("swing_lookback", [5, 10]), ("smc_conf_type", ["BODY_CLOSE", "WICK_TOUCH"]), ("smc_vol_len", [14, 20])],
    "VOLUME": [("ema_fast", [9, 12]), ("ema_slow", [21, 26]), ("use_pullback", [True, False]),
               ("pullback_tol_pct", [0.3, 0.5]), ("tp3_rr", [2.5, 9.9]), ("setup_cross", [True, False])],
}


def _in_space(rng, d):
    t = d["type"]
    if t == "float":
        lo, hi, step = d["min"], d["max"], d.get("step", 0.1)
        n = max(1, int((hi - lo) / step))
        return round(lo + rng.randint(0, n) * step, 4)
    if t == "int":
        return rng.randint(d["min"], d["max"])
    if t == "choice":
        return rng.choice(d["values"])
    return rng.choice([True, False])


def _wild(rng, d):
    t = d["type"]
    if t == "float":
        lo, hi = d["min"], d["max"]
        span = hi - lo
        k = rng.random()
        if k < 0.15:
            return rng.choice([0.0, 0, -0.5, -1, 99.0, 1e-9, 10])
        if k < 0.3:
            return int(round(rng.uniform(lo - span, hi + span)))          # an int in a float gene
        return round(rng.uniform(lo - span, hi + span), rng.choice([1, 2, 3, 6]))
    if t == "int":
        k = rng.random()
        if k < 0.3:
            return round(rng.uniform(d["min"] - 2, d["max"] + 2), rng.choice([1, 2]))   # a float in an int gene
        return rng.randint(d["min"] - 3, d["max"] + 3)
    if t == "choice":
        vals = d["values"]
        if rng.random() < 0.3 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals):
            return rng.choice(vals) + rng.choice([-1, 1, 0.5, 100])
        return rng.choice(vals)
    return rng.choice([True, False, 0, 1])


def section_constraints():
    rng = pyrandom.Random(81101)
    out = {}
    for strat, space in genome.GENE_SPACE.items():
        cases = []
        for k in range(500):
            kind = ["space", "space", "wild", "wild", "missing", "legacy", "mixed"][k % 7]
            if k % 50 == 49:
                kind = "none"
            g = {}
            for name, d in space.items():
                if kind == "space":
                    g[name] = _in_space(rng, d)
                elif kind in ("wild", "mixed"):
                    g[name] = _wild(rng, d) if (kind == "wild" or rng.random() < 0.5) else _in_space(rng, d)
                else:
                    g[name] = _in_space(rng, d)
            if kind in ("missing", "mixed", "legacy"):
                for name in list(g):
                    if rng.random() < (0.35 if kind == "missing" else 0.1):
                        del g[name]
            if kind in ("legacy", "mixed"):
                for name, vals in LEGACY[strat]:
                    if rng.random() < 0.5:
                        g[name] = rng.choice(vals)
            if kind == "none":
                keys = list(g)
                for name in rng.sample(keys, min(len(keys), rng.randint(1, 3))):
                    g[name] = None
            # targeted rule triggers
            if strat == "LEVELS" and rng.random() < 0.1:
                g["use_rsi"] = False; g["use_volume"] = False; g["min_quality"] = rng.choice([3, 4, 5])
            if strat == "LEVELS" and rng.random() < 0.05:
                g["ema_fast"] = rng.choice([26, 50, 120]); g["ema_slow"] = rng.choice([26, 50])
            if strat == "SMC" and rng.random() < 0.1:
                g["smc_use_volume_filter"] = True; g["min_confirmations"] = rng.choice([4, 5])
            if strat == "SMC" and rng.random() < 0.1:
                g["min_rr"] = rng.choice([2.31, 2.4, 2.5]); g["min_confirmations"] = rng.choice([4, 6])
            if strat == "VOLUME" and rng.random() < 0.1:
                g["vol_mult"] = rng.choice([2.2, 2.4, 2.5]); g["min_quality"] = rng.choice([4, 4.0, 5, "4"])
            if strat == "VOLUME" and rng.random() < 0.08:
                g["climax_mult"] = rng.choice([0, 0.0, None, 3.0]); g["vol_mult"] = rng.choice([0, 2.0, 1.5])
            if strat == "VOLUME" and rng.random() < 0.08:
                g["tp1_rr"] = rng.choice([0, 1.6, 2.5]); g["tp2_rr"] = rng.choice([0, 1.5, 2.0])
            seed = 7000 + k
            try:
                fixed = mgv.with_shim(seed, genome._fix_constraints, copy.deepcopy(g), strat)
                res = {"out": fixed, "out_json": genome.serialize_genome(fixed)}
            except Exception as e:  # noqa: BLE001
                res = {"error": type(e).__name__}
            cases.append(dict({"kind": kind, "seed": seed, "in": g}, **res))
        out[strat] = cases
    emit("constraints", out)


# ─────────────────────────────────────────────────────────────────────────────
# fitness: evaluate_genome over synthetic trade lists
# ─────────────────────────────────────────────────────────────────────────────

def _stamp(rng, base_day):
    return f"2026-{rng.randint(1, 9):02d}-{base_day:02d} {rng.randint(0, 23):02d}:{rng.choice(['00', '15', '30', '45'])}:00"


def _trades(rng, n, rr_fn, stamps, blank_rate=0.0, none_rate=0.0):
    out = []
    for _ in range(n):
        rr = rr_fn()
        t = {"entry_time": rng.choice(stamps), "exit_time": rng.choice(stamps + [""]), "rr_realized": rr,
             "result": "TP1" if rr > 0 else ("BE" if rr == 0 else "SL")}
        if rng.random() < blank_rate:
            t["entry_time"] = ""; t["exit_time"] = ""
        if rng.random() < none_rate:
            t["rr_realized"] = None
        out.append(t)
    return out


def _fitness_case(rng, k):
    strat = ["LEVELS", "SMC", "VOLUME"][k % 3]
    tf = rng.choice(["15m", "1h", "4h"])
    kind = ["random", "empty", "all_be", "all_loss", "single", "min_edge", "same_ts", "big", "wf", "pf_cap",
            "tiny_rr", "mixed_none"][k % 12]
    n_stamps = 3 if kind == "same_ts" else rng.randint(5, 60)
    stamps = sorted({_stamp(rng, rng.randint(10, 28)) for _ in range(n_stamps)})
    rr_pool = [-1.123, -1.121, -1.0012, -0.215, 0.0, 0.153, 0.42, 0.871, 1.204, 2.317, 0.1, 0.2, 0.3, -0.1, -0.2]

    def rr_any():
        return rng.choice(rr_pool + [round(rng.uniform(-1.3, 3.2), 3)])

    min_t = genome._eval_min_trades(strat)
    pre = {}
    n_coins = rng.randint(1, 9)
    for c in range(n_coins):
        if kind == "empty":
            n, fn = 0, rr_any
        elif kind == "all_be":
            n, fn = rng.randint(1, 30), (lambda: 0.0)
        elif kind == "all_loss":
            n, fn = rng.randint(1, 30), (lambda: rng.choice([-1.123, -1.121, -0.5, round(rng.uniform(-1.3, -0.01), 3)]))
        elif kind == "single":
            n, fn = (1 if c == 0 else 0), rr_any
        elif kind == "min_edge":
            n, fn = 0, rr_any
        elif kind == "big":
            n, fn = rng.randint(25, 60), rr_any
        elif kind == "wf":
            n, fn = rng.randint(3, 8), rr_any
        elif kind == "pf_cap":
            n, fn = rng.randint(1, 6), (lambda: rng.choice([1.5, 2.3, 0.4, 0.4, 0.0, -0.05]))
        elif kind == "tiny_rr":
            n, fn = rng.randint(2, 15), (lambda: rng.choice([0.001, -0.001, 0.1, 0.2, 0.3, -0.3, 1e-9]))
        else:
            n, fn = rng.choice([0, 1, 2, 3, 5, 8, 13, rng.randint(0, 40)]), rr_any
        trades = _trades(rng, n, fn, stamps, blank_rate=0.03 if kind == "mixed_none" else 0.0,
                         none_rate=0.05 if kind == "mixed_none" else 0.0)
        pf = rng.choice([float("inf"), round(rng.uniform(0.2, 4), 6), 0.0])
        pre[f"V{k:03d}{c}-USDT-SWAP"] = {"total_trades": n, "profit_factor": pf, "trades": trades}
    if kind == "min_edge":
        # exactly min_t − 1 / min_t / min_t + 1 usable trades in one coin
        n = min_t + rng.choice([-1, 0, 1])
        pre[f"V{k:03d}E-USDT-SWAP"] = {"total_trades": n, "profit_factor": 1.0, "trades": _trades(rng, n, rr_any, stamps)}
    if kind == "big" and k % 24 == 7:
        # exactly 175 / 184 test trades for the glibc log1p pins
        target = rng.choice([175, 184])
        split = genome._oos_split(strat)
        total = next(t for t in range(target, target * 3) if t - int(t * split) == target)
        pre = {f"V{k:03d}B-USDT-SWAP": {"total_trades": total, "profit_factor": 1.2,
                                         "trades": _trades(rng, total, rr_any, stamps)}}
    if k % 29 == 0:
        pre[f"ERR{k}-USDT-SWAP"] = {"raise": True, "total_trades": 0, "profit_factor": 0, "trades": []}
    baseline = rng.choice([None, None, 0.0, -5.0, 20.0, 33.3, 45.5, 60.0, 80.0])
    g = mgv.with_shim(k + 900, genome.random_genome, strat)
    return strat, tf, kind, g, pre, baseline


def section_fitness():
    rng = mgv.REAL_RANDOM(9090)
    backtest.Backtester = mgv.FakeBT
    pyrandom.Random = mgv.RecRandom
    genome.time = mgv.FrozenTime(NOW)
    kv = mgv.FakeKV()
    mgv._install_fake_db(kv)
    cases = []
    try:
        for k in range(200):
            strat, tf, kind, g, pre, baseline = _fitness_case(rng, k)
            kv.d.clear()
            if k % 31 == 5:
                for coin in pre:
                    kv.d[f"genome_coin_champ_{strat}_{tf}_{coin}"] = json.dumps({"coin_fit": 0.0, "ts": NOW - 8 * 86400})
            before = dict(kv.d)
            mgv.MC_RECORD.clear()
            genome._eval_cache.clear()
            out = asyncio.run(genome.evaluate_genome(strat, g, tf, _preloaded=pre, _live_wr_baseline=baseline))
            writes = {kk: v for kk, v in kv.d.items() if before.get(kk) != v}
            cases.append({"kind": kind, "strategy": strat, "tf": tf, "genome": g, "preloaded": pre, "baseline": baseline,
                          "out": out, "mc_p95_raw": mgv.mc_p95_from_record(), "kv_before": before, "kv_writes": writes})
    finally:
        backtest.Backtester = mgv.REAL_BT
        pyrandom.Random = mgv.REAL_RANDOM
        genome.time = mgv.REAL_GENOME_TIME
        _restore_kv()
    r2 = mgv.REAL_RANDOM(4545)
    cf = []
    for n in (0, 1, 2, 7, 8, 9, 49, 50, 51, 52, 174, 175, 176, 184, 185, 400):
        for wr in (0, 0.35, 0.3499, 1.0, 1.0001, 34.99, 35.0, 50, 100, 100.5):
            for pf in (0.0, 1.19, 1.2, 5.0, 10.0):
                for dd in (0, 0.5, 1.0, 1.0000001, 7.5):
                    if r2.random() < 0.06:
                        cf.append({"winrate": wr, "profit_factor": pf, "trades": n, "drawdown": dd,
                                   "out": genome.compute_fitness(wr, pf, n, dd)})
    emit("fitness", {"now": NOW, "cases": cases, "compute_fitness": cf})


# ─────────────────────────────────────────────────────────────────────────────
# backtests: 6 fixtures × 3 strategies × 5 genomes
# ─────────────────────────────────────────────────────────────────────────────

BT_COINS = ("ETH-USDT-SWAP", "SYNUP03-USDT-SWAP", "SYNRG05-USDT-SWAP", "SYNVL02-USDT-SWAP",
            "PEPEVL07-USDT-SWAP", "DOGEVL08-USDT-SWAP")
BT_TF = os.environ.get("GENOME_VERIFY_TF", "15m")


def _bt_genomes():
    gs = {}
    rng = pyrandom.Random(5555)
    for strat in ("LEVELS", "SMC", "VOLUME"):
        lst = []
        for j in range(5):
            g = {name: _in_space(rng, d) for name, d in genome.GENE_SPACE[strat].items()}
            if strat == "LEVELS":
                # trade-producing corners: weak pivots / low quality / short cooldown / wide distance
                g.update(({"pivot_strength": 3, "min_quality": 2, "cooldown_bars": 3, "max_dist_pct": 2.0, "min_rr": 1.2},
                           {"pivot_strength": 5, "min_quality": 2, "use_rsi": False, "use_volume": False},
                           {"pivot_strength": 3, "min_quality": 3, "use_volume": True, "zone_pct": 1.1},
                           {"pivot_strength": 7, "min_quality": 2, "cooldown_bars": 12},
                           {"pivot_strength": 10, "min_quality": 2, "min_rr": 1.5})[j])
            if strat == "SMC":
                g.update(({"min_confirmations": 2, "min_rr": 1.5},
                           {"min_confirmations": 2, "fvg_enabled": False, "choch_enabled": False, "ob_use_breaker": False},
                           {"min_confirmations": 3, "smc_use_volume_filter": True, "smc_vol_mult": 1.0},
                           {"min_confirmations": 2, "sweep_close_req": True, "smc_pd_filter": False, "sl_buffer_pct": 0.1},
                           {"min_confirmations": 4, "min_rr": 2.5})[j])
            if strat == "VOLUME" and j == 0:
                g.update({"ma_type": "sma", "vol_mult": 1.2, "min_quality": 2})
            lst.append(genome._fix_constraints(g, strat))
        gs[strat] = lst
    return gs


class ReplayBT:
    RESULTS = {}

    def __init__(self, strategy, params=None, silent=False, fast_mode=False):
        self.params = params

    def run_in_thread(self, coin, df, tf, days):
        return ReplayBT.RESULTS[coin]

    async def close(self):
        return None


def section_backtests():
    import time as _t
    gs = _bt_genomes()
    only = os.environ.get("GENOME_VERIFY_ONLY")          # e.g. "LEVELS" — split long runs
    dfs = {sym: pyenv.load_df(sym, BT_TF) for sym in BT_COINS}
    runs, evals = [], []
    for strat, glist in gs.items():
        if only and strat != only:
            continue
        for gi, g in enumerate(glist):
            p = dict(g)
            p.setdefault("fee_pct", genome.FEE_ROUND_TRIP_PCT)
            p.setdefault("slippage_extra_pct", genome.SLIPPAGE_PCT)
            days = genome._eval_days_for_tf(BT_TF, strat)
            ReplayBT.RESULTS = {}
            for sym in BT_COINS:
                t0 = _t.time()
                bt = backtest.Backtester(strat, params=dict(p), silent=True, fast_mode=True)
                r = bt.run_in_thread(sym, dfs[sym], BT_TF, days)
                ReplayBT.RESULTS[sym] = r
                d = dict(r.__dict__)
                runs.append({"strategy": strat, "g": gi, "symbol": sym, "tf": BT_TF, "days": days, "result": d})
                print(f"backtest {strat}#{gi} {sym}: {r.total_trades} trades {(_t.time() - t0):.1f}s", file=sys.stderr, flush=True)
            # evaluate_genome over the recorded results (the same coin order as the preload)
            backtest.Backtester = ReplayBT
            pyrandom.Random = mgv.RecRandom
            genome.time = mgv.FrozenTime(NOW)
            kv = mgv.FakeKV()
            mgv._install_fake_db(kv)
            try:
                mgv.MC_RECORD.clear()
                genome._eval_cache.clear()
                out = asyncio.run(genome.evaluate_genome(strat, g, BT_TF, _preloaded=dict(dfs)))
            finally:
                backtest.Backtester = mgv.REAL_BT
                pyrandom.Random = mgv.REAL_RANDOM
                genome.time = mgv.REAL_GENOME_TIME
                _restore_kv()
            evals.append({"strategy": strat, "g": gi, "tf": BT_TF, "out": out, "mc_p95_raw": mgv.mc_p95_from_record(),
                          "kv_writes": dict(kv.d)})
    suffix = f"_{only.lower()}" if only else ""
    emit(f"backtests{suffix}", {"now": NOW, "tf": BT_TF, "coins": list(BT_COINS), "genomes": gs, "runs": runs, "evaluate": evals})


WIDE_COINS = BT_COINS + ("SYNUP01-USDT-SWAP", "SYNDN02-USDT-SWAP", "SYNRG01-USDT-SWAP", "SYNVL04-USDT-SWAP",
                         "SYNLV03-USDT-SWAP", "SYNLV05-USDT-SWAP")


def section_wide():
    """The same 5 genomes per strategy on 1h and 4h (400 bars) over 12 golden fixtures."""
    gs = _bt_genomes()
    runs = []
    for tf in ("1h", "4h"):
        dfs = {sym: pyenv.load_df(sym, tf) for sym in WIDE_COINS}
        for strat, glist in gs.items():
            for gi, g in enumerate(glist):
                p = dict(g)
                p.setdefault("fee_pct", genome.FEE_ROUND_TRIP_PCT)
                p.setdefault("slippage_extra_pct", genome.SLIPPAGE_PCT)
                days = genome._eval_days_for_tf(tf, strat)
                for sym in WIDE_COINS:
                    r = backtest.Backtester(strat, params=dict(p), silent=True, fast_mode=True).run_in_thread(sym, dfs[sym], tf, days)
                    runs.append({"strategy": strat, "g": gi, "symbol": sym, "tf": tf, "days": days, "result": dict(r.__dict__)})
                print(f"wide {tf} {strat}#{gi}: {sum(x['result']['total_trades'] for x in runs[-len(WIDE_COINS):])} trades",
                      file=sys.stderr, flush=True)
    emit("wide", {"now": NOW, "coins": list(WIDE_COINS), "genomes": gs, "runs": runs})


# ─────────────────────────────────────────────────────────────────────────────
# apply_best_to_user: 20 population scenarios per strategy
# ─────────────────────────────────────────────────────────────────────────────

def _smc_cfgs():
    import user_manager
    base = user_manager.SMCUserCfg()
    d0 = json.loads(base.to_json())
    out = [base.to_json(), "{}", "", None, "not json", "[]", "null", "5", '"x"',
           json.dumps(dict(d0, min_rr=2, sl_buffer_pct=1e-05, min_volume_usdt=300000.0, note="привет \"q\"")),
           json.dumps({"tf_key": "15m", "min_rr": 1.5, "ob_max_age": 80.0, "fvg_enabled": 1, "smc_retrace_depth": 0}),
           json.dumps(dict(d0, smc_vol_mult=1.0, choch_enabled=False, extra={"a": 1})),
           '{"min_rr": 2.0, "min_confirmations": 3, "sweep_close_req": true, "scan_interval": 300}',
           json.dumps({"min_rr": -0.0, "sl_buffer_pct": 0.35, "big": 12345678901, "tiny": 1.5e-07})]
    return out


def _vol_kvs():
    return [None, json.dumps({"setup_cross": False, "use_htf": False, "vol_mult": 2.0}),
            json.dumps({"setup_ribbon": False, "ma_type": "sma", "ma_fast": 10, "setup_bounce": False}),
            json.dumps({"use_htf": True, "setup_golden": False, "setup_turn": False}), "garbage", "[]",
            json.dumps({"setup_cross": True, "setup_turn": True, "setup_bounce": True, "setup_golden": True,
                        "setup_ribbon": True, "use_htf": False, "tp3_rr": 7.0})]


async def _apply_async(out):
    import aiosqlite
    import database as db
    import optimizer
    tmpdir = tempfile.mkdtemp(prefix="genome_verify_")
    out["_tmpdir"] = tmpdir
    path = os.path.join(tmpdir, "bot.db")
    await db.init_db(path)
    genome.time = mgv.FrozenTime(NOW)
    optimizer.time = mgv.FrozenTime(NOW)
    rng = pyrandom.Random(20202)
    smc_cfgs = _smc_cfgs()
    vol_kvs = _vol_kvs()
    async with aiosqlite.connect(path) as cx:
        cx.row_factory = None
        async with cx.execute("PRAGMA table_info(users)") as cur:
            out["bot_user_cols"] = [r[1] for r in await cur.fetchall()]
        cases = []
        scenario = 0
        for strat in ("LEVELS", "SMC", "VOLUME"):
            space = genome.GENE_SPACE[strat]
            for v in range(20):
                scenario += 1
                await mgv._db_reset(db, cx)
                uid = 5000 + scenario
                user = {"genome_auto_apply": 0, "strategy": strat, "extra_strategies": "", "vol_timeframe": "1h",
                        "timeframe": "1h", "long_tf": "1h", "short_tf": "1h", "long_active": 0, "short_active": 0,
                        "active": 1, "scan_mode": "both", "smc_cfg": "{}"}
                # LEVELS columns: random, sometimes the genome's own value as int/float/bool twin
                for c in mgv.LEVELS_COLS:
                    d = genome.GENE_SPACE["LEVELS"][c]
                    val = _in_space(rng, d)
                    user[c] = int(val) if isinstance(val, bool) else val
                tf = genome.get_default_tf(strat) if v % 4 else rng.choice(genome.get_tfs(strat))
                pass_tf = bool(v % 3 == 0 or tf != genome.get_default_tf(strat))
                items = []
                for k in range(rng.randint(1, 6)):
                    g = {name: _in_space(rng, d) for name, d in space.items()}
                    g = genome._fix_constraints(g, strat) if strat != "VOLUME" else mgv.with_shim(scenario * 7 + k, genome._fix_constraints, g, strat)
                    items.append({"genome": g, "fitness": round(rng.uniform(0.05, 3), rng.choice([2, 4])),
                                  "winrate": round(rng.uniform(30, 70), 2), "profit_factor": round(rng.uniform(0.5, 3), 2),
                                  "trades": rng.randint(3, 60), "drawdown": round(rng.uniform(0, 5), 2)})
                kind = "ok"
                if v == 1:
                    kind = "tie"                         # two equal best fitness values (first in ORDER BY wins)
                    if len(items) < 2:
                        items.append(copy.deepcopy(items[0]))
                        items[-1]["genome"] = {name: _in_space(rng, d) for name, d in space.items()}
                    top = max(it["fitness"] for it in items)
                    items[-1]["fitness"] = top
                elif v == 2:
                    kind = "best_low_trades"
                    best = max(items, key=lambda it: it["fitness"])
                    best["trades"] = rng.choice([0, 1, 2])
                elif v == 3:
                    kind = "fitness_zero"
                    for it in items:
                        it["fitness"] = rng.choice([0.0, -0.5])
                elif v == 4:
                    kind = "no_evolution"
                elif v == 5:
                    kind = "user_missing"
                elif v == 6:
                    kind = "user_equal"                  # the user already has the best genome's values
                elif v == 7:
                    kind = "legacy_keys"
                    for it in items:
                        it["genome"].update({"use_pattern": True, "foo_bar": 3, "tp3_rr": 4.5, "max_level_age": 80,
                                             "not_a_column": "zz"} if strat == "LEVELS" else
                                            {"swing_lookback": 8, "smc_conf_type": "WICK_TOUCH", "new_key": [1, 2]} if strat == "SMC" else
                                            {"ema_fast": 9, "use_pullback": True, "setup_cross": False, "unknown": 1})
                elif v == 8:
                    kind = "empty_genome"
                    for it in items:
                        it["genome"] = {}
                elif v == 9:
                    kind = "older_generation"            # a newer generation exists: only it counts
                if kind != "no_evolution":
                    await mgv._insert_pop(cx, strat, tf, 4, items)
                    if kind == "older_generation":
                        older = copy.deepcopy(items)
                        for it in older:
                            it["fitness"] = it["fitness"] + 10
                        await mgv._insert_pop(cx, strat, tf, 3, older)
                best_now = max(items, key=lambda it: it["fitness"]) if items else None
                if kind == "user_equal" and best_now and strat == "LEVELS":
                    for c, val in best_now["genome"].items():
                        if c in user:
                            user[c] = (int(val) if isinstance(val, bool) else
                                       float(val) if isinstance(val, int) and rng.random() < 0.5 else val)
                if strat == "SMC":
                    user["smc_cfg"] = smc_cfgs[v % len(smc_cfgs)]
                    if kind == "user_equal" and best_now:
                        user["smc_cfg"] = json.dumps(dict(best_now["genome"]))
                kv_init = vol_kvs[v % len(vol_kvs)] if strat == "VOLUME" else None
                if kind != "user_missing":
                    await mgv._insert_user(cx, uid, user)
                if kv_init is not None:
                    await cx.execute("INSERT INTO kv (key, value) VALUES (?, ?)", (f"volume_cfg_{uid}", kv_init))
                await cx.commit()
                try:
                    res = await genome.apply_best_to_user(uid, strat, tf if pass_tf else None)
                except Exception as e:  # noqa: BLE001
                    res = {"__raised__": type(e).__name__}
                cx.row_factory = None
                async with cx.execute("SELECT value FROM kv WHERE key=?", (f"volume_cfg_{uid}",)) as cur:
                    kvr = await cur.fetchone()
                cases.append({"strategy": strat, "tf": tf, "pass_tf": pass_tf, "uid": uid, "kind": kind,
                              "user": None if kind == "user_missing" else user, "kv_init": kv_init,
                              "populations": {"4": items} if kind != "no_evolution" else {},
                              "older": older if kind == "older_generation" else None,
                              "result": res, "user_after": await mgv._user_state(cx, uid),
                              "kv_after": kvr[0] if kvr else None})
        out["cases"] = cases


def section_apply():
    out = {"now": NOW}
    try:
        asyncio.run(_apply_async(out))
    finally:
        shutil.rmtree(out.pop("_tmpdir", ""), ignore_errors=True)
        genome.time = mgv.REAL_GENOME_TIME
    emit("apply", out)


# ─────────────────────────────────────────────────────────────────────────────
# routes: miniapp_api.h_genome / h_genome_apply
# ─────────────────────────────────────────────────────────────────────────────

class _RUser:
    def __init__(self, uid, can, auto):
        self.user_id = uid
        self._can = can
        self.genome_auto_apply = auto

    def can(self, feature):
        return self._can


class _Req:
    def __init__(self, body, raw=None):
        self._body = body
        self._raw = raw
        self.method = "POST"

    async def json(self):
        if self._raw is not None:
            return json.loads(self._raw)
        return self._body


async def _routes_async(out):
    import aiosqlite
    import database as db
    import miniapp_api as mapi
    tmpdir = tempfile.mkdtemp(prefix="genome_verify_routes_")
    out["_tmpdir"] = tmpdir
    path = os.path.join(tmpdir, "bot.db")
    await db.init_db(path)
    genome.time = mgv.FrozenTime(NOW)
    rng = pyrandom.Random(31313)
    box = {}

    async def fake_load_user(request):
        return None, box["user"]
    mapi._load_user = fake_load_user

    def body_of(resp):
        return {"status": resp.status, "body": json.loads(resp.text)}

    gets, posts = [], []
    async with aiosqlite.connect(path) as cx:
        for k in range(24):
            await mgv._db_reset(db, cx)
            uid = 7000 + k
            box["user"] = _RUser(uid, can=bool(k % 5), auto=bool(k % 3 == 0))
            hist_rows, kv_rows = {}, []
            for s in ("LEVELS", "SMC", "VOLUME"):
                tf = genome.get_default_tf(s)
                rows = []
                if (k + len(s)) % 4:
                    for gnum in sorted(rng.sample(range(1, 40), rng.randint(1, 4))):
                        rows.append({"generation": gnum,
                                     "best_fitness": rng.choice([None, 0.0, round(rng.uniform(0, 3), rng.choice([3, 4, 6])), 1.2345, 2.0005]),
                                     "avg_fitness": round(rng.uniform(0, 1), 3),
                                     "best_wr": rng.choice([None, round(rng.uniform(20, 80), rng.choice([1, 2, 3])), 55.55, 49.95]),
                                     "best_pf": rng.choice([None, round(rng.uniform(0.2, 4), rng.choice([2, 3])), 1.555, 1.005]),
                                     "best_genome": {"min_rr": 2.0},
                                     "created_at": rng.choice([NOW - rng.uniform(0, 9e5), float(int(NOW)), None, 0])})
                    other_tf = [t for t in genome.get_tfs(s) if t != tf]
                    if other_tf:
                        await mgv._insert_hist(cx, s, other_tf[0], [{"generation": 99, "best_fitness": 9.9, "avg_fitness": 1,
                                                                    "best_wr": 99, "best_pf": 9, "created_at": NOW}])
                    await mgv._insert_hist(cx, s, tf, rows)
                hist_rows[s] = rows
                last = max(rows, key=lambda r: r["generation"]) if rows else None
                mark = rng.choice([None, "x", str(last["generation"]) if last else "1", str(last["generation"] - 1) if last else "0",
                                   f"{last['generation']}.0" if last else "2"])
                if mark is not None:
                    kv_rows.append([f"miniapp_genome_applied_{uid}_{s}", mark])
                    await cx.execute("INSERT INTO kv (key, value) VALUES (?, ?)", kv_rows[-1])
            await cx.commit()
            resp = await mapi.h_genome(None)
            gets.append({"uid": uid, "can": box["user"]._can, "auto": box["user"].genome_auto_apply,
                         "history": hist_rows, "kv": kv_rows, "resp": body_of(resp)})
        # h_genome_apply
        bodies = [{"strategy": "levels"}, {"strategy": "SMC"}, {"strategy": "Volume"}, {"strategy": "x"}, {}, {"strategy": 1},
                  {"strategy": ["LEVELS"]}, {"strategy": None}, {"strategy": " LEVELS"}]
        raws = [None] * len(bodies) + ["[1, 2]", "\"LEVELS\"", "not json", "{\"strategy\": \"levels\", \"strategy\": \"smc\"}"]
        bodies += [None, None, None, None]
        for k, (b, raw) in enumerate(zip(bodies, raws)):
            for can in (True, False):
                for ready in (True, False):
                    await mgv._db_reset(db, cx)
                    uid = 8000 + k * 4 + can * 2 + ready
                    box["user"] = _RUser(uid, can=can, auto=False)
                    user = {"genome_auto_apply": 0, "strategy": "LEVELS", "extra_strategies": "", "vol_timeframe": "1h",
                            "timeframe": "1h", "long_tf": "1h", "short_tf": "1h", "long_active": 0, "short_active": 0,
                            "active": 1, "scan_mode": "both", "smc_cfg": "{}", "min_rr": 2.0, "min_quality": 3}
                    await mgv._insert_user(cx, uid, user)
                    pops = {}
                    if ready:
                        for s in ("LEVELS", "SMC", "VOLUME"):
                            items = [{"genome": mgv.with_shim(k + 3, genome.random_genome, s), "fitness": 1.5, "winrate": 55.0,
                                      "profit_factor": 1.6, "trades": 20}]
                            await mgv._insert_pop(cx, s, genome.get_default_tf(s), 6, items)
                            pops[s] = items
                    await cx.commit()
                    req = _Req(b, raw)
                    resp = await mapi.h_genome_apply(req)
                    cx.row_factory = None
                    async with cx.execute("SELECT key, value FROM kv WHERE key LIKE 'miniapp_genome_applied_%' ORDER BY key") as cur:
                        marks = [list(r) for r in await cur.fetchall()]
                    posts.append({"uid": uid, "can": can, "ready": ready, "body": b, "raw": raw, "user": user,
                                  "populations": pops, "resp": body_of(resp), "marks": marks})
    out["get"] = gets
    out["post"] = posts


def section_routes():
    out = {"now": NOW}
    try:
        asyncio.run(_routes_async(out))
    finally:
        shutil.rmtree(out.pop("_tmpdir", ""), ignore_errors=True)
        genome.time = mgv.REAL_GENOME_TIME
    emit("routes", out)


if __name__ == "__main__":
    for s in SECTIONS:
        print(f"== {s}", file=sys.stderr)
        globals()[f"section_{s}"]()
    sys.stderr.flush()
    sys.stdout.flush()
    os._exit(0)
