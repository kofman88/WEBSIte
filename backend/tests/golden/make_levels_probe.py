#!/usr/bin/env python
"""make_levels_probe.py — LEVELS differential probe: the bot's CHMIndicator on inputs the main golden
sweep (expected/levels.json: 3 variants × 1h growing prefix, fresh instance per bar, production env)
does NOT reach. Every swept bar records either the full signal (dataclasses.asdict(SignalResult) +
the scanner's pure post-steps) or the _ANALYZE_STATS reject bucket ("none" when no bucket), exactly
like make_golden.run_levels, so tests/levels/probe.test.js replays it with compare.js rules.

Sections (case name prefixes):
  cls_*      symbol classes on identical candles: memcoin keywords (PEPE, 1000BONK, DOGE, SHIB, WIF,
             FLOKI, …, substring traps FACT/MEMEFI), majors (BTC, ETH, ETHFI, WBTC), plain alts, a
             memcoin+major mix → minimum stop 1.5 / 0.4 / 0.8 % and the memcoin quality cap 5
  tf_*       working timeframes 15m / 30m (pairs of 15m bars) / 4h / 1d (TradeCfg.timeframe =
             the job TF → regime slope threshold per TF incl. the "1d" → 0.001 fallback; session
             penalty by the hour of df.index[-1]); 1D HTF zones on/off
  corr_*     BTC/ETH correlation frames: absent / BTC only / short (≤ 10 and 11 bars) / stale /
             other TF (1h for a 15m job) / the symbol itself
  mode_*     HIGH_WR on 15m/1h/4h/1d, momentum relaxed mode (ATR-breakout fallback, relax_min_rr,
             relax_min_quality), LEVELS_RELAX_ENABLED, SL-V2 + cached BTC regime, entry-filter modes
             (regime off/shadow, vol enforce, confirm enforce/shadow), LEVELS_MIN_RR env
  cfg_*      TradeCfg at the min / max values the bot UI and the Mini App accept, ema_slow 500, all
             filters off, inverted TP ladders (fixed by __post_init__)
  rand*      44 seeded random valid configs (bot UI value lists + Mini App float ranges, random TF,
             HIGH_WR, relaxed, env gates, correlation mode, symbol aliases)
  deg_*      degenerate frames: fewer bars than required (analyze and analyze_on_demand 50..60 bars),
             zero / NaN volume, flat candles, a constant tail (zero ATR), 40× volume spikes, long
             wicks, ±4 % price jumps, dropped bars (time gaps), price scales ~1e-7 and ~1e5, prices
             sitting on round numbers (psychological levels near 1, 25, 100, 1000, 50000)
  live_*     the live path of ONE persistent CHMIndicator per case (bars outer, symbols inner, like a
             scanner cycle): cooldown (mark_signal after every signal, bars_since_signal rounding on
             time gaps), the zone cache with its TTL by TIMEFRAME and the pre-filter (the indicator's
             clock is patched: clock = t0 + k·clock_step), cache eviction (_ZONE_CACHE_MAX patched),
             the HTF zone cache, the ATR-breakout cooldown in relaxed mode

Frame rule (replayed by probe.test.js): base = mutate(working-TF frame of `src`); for swept index i
  df = base[max(0, i−W+1) : i+1] (W = window) or base[:i+1] (window null);
  close_ms = open_ms[i] + TF; df_htf = 1D bars closed at close_ms, last htf_window (only when use_htf);
  BTC/ETH = bars of the same TF closed at close_ms, last 299 (corr mode may change that).

Re-running (bot repo + pinned venv, exactly like make_golden.py — see FIXTURES.md "Re-running"):
    BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python -I <backend/tests/golden>/make_levels_probe.py
    rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
writes levels_probe.json.gz and levels_probe_summary.json next to this file (counts + sha256 asserted
by the test). Options: --cases prefix1,prefix2 (debug subset, does not write), --workers N.
"""
import argparse
import dataclasses as dc
import gzip
import hashlib
import json
import math
import os
import random
import sys
import time

for _k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_k, "1")      # one BLAS thread per worker process (4 workers would oversubscribe the cores)
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.environ.get("GOLDEN_OUT_DIR", HERE)
sys.path.insert(0, HERE)
import make_golden as mg  # noqa: E402  (BOT_DIR on sys.path, chdir into the bot repo, pinned env flags)

import numpy as np  # noqa: E402

TF_MS = {"15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
CORR_WINDOW = 299
TRIGGER = "BTC pump +2.50% за 1H"

PROD_ENV = {"LEVELS_REGIME_GATE": "enforce", "LEVELS_VOL_GATE": "off", "LEVELS_MAX_ATR_PCT": 2.5,
            "LEVELS_ENTRY_CONFIRM": "off", "LEVELS_MIN_RR": 1.8, "LEVELS_RELAX_ENABLED": False,
            "SL_V2_LEVELS_ENABLED": False}
OFF_ENV = dict(PROD_ENV, LEVELS_REGIME_GATE="off")

# a config that lets far more bars reach the late stages (stops / targets / quality)
LOOSE = dict(max_dist_pct=3.0, zone_pct=0.3, vol_mult=0.7, use_volume=False, use_rsi=False, max_risk_pct=3.0, min_rr=1.0)
LOOSE_VOL = dict(LOOSE, use_volume=True)   # the same with the VOL_MULT×0.7 gate on

RG = ["SYNRG03-USDT-SWAP", "SYNRG05-USDT-SWAP", "SYNLV04-USDT-SWAP", "SYNVL04-USDT-SWAP"]
MIX = ["SYNRG05-USDT-SWAP", "SYNLV06-USDT-SWAP", "SYNVL03-USDT-SWAP", "SYNRG07-USDT-SWAP"]
ALL_SRC = None  # filled from candles/index.json


def _same(srcs):
    return [[s, s] for s in srcs]


def _alias(srcs, names):
    return [[s, n] for s, n in zip(srcs, names)]


def case(tf="1h", window=None, sweep=160, step=1, symbols=None, trade_cfg=None, high_wr=False, env=None,
         regime=None, relaxed=False, corr="same", htf_window=299, mutate=None, mode="fresh", call="analyze",
         clock_step=None, cache_max=None):
    tc = dict(trade_cfg or {})
    tc.setdefault("timeframe", tf)
    return dict(tf=tf, window=window, sweep=sweep, step=step, symbols=symbols or _same(RG), trade_cfg=tc,
                high_wr=bool(high_wr), env=dict(env or PROD_ENV), regime=regime, relaxed=bool(relaxed), corr=corr,
                htf_window=htf_window, mutate=mutate, mode=mode, call=call, clock_step=clock_step, cache_max=cache_max)


CASES = {}

# ── symbol classes: identical candles under different names ──
_CLS_SRC = ["SYNRG05-USDT-SWAP", "SYNRG03-USDT-SWAP", "SYNLV04-USDT-SWAP", "SYNVL04-USDT-SWAP", "SYNRG07-USDT-SWAP"]
for _nm, _names in {
    "cls_meme": ["PEPE-USDT-SWAP", "1000BONK-USDT-SWAP", "DOGE-USDT-SWAP", "SHIB-USDT-SWAP", "WIF-USDT-SWAP"],
    "cls_meme2": ["FLOKI-USDT-SWAP", "NEIRO-USDT-SWAP", "TURBO-USDT-SWAP", "BOME-USDT-SWAP", "1000SATS-USDT-SWAP"],
    "cls_major": ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "ETHFI-USDT-SWAP", "WBTC-USDT-SWAP", "BTCDOM-USDT-SWAP"],
    "cls_alt": ["SOL-USDT-SWAP", "XRP-USDT-SWAP", "ADA-USDT-SWAP", "SUI-USDT-SWAP", "LINK-USDT-SWAP"],
    "cls_traps": ["FACT-USDT-SWAP", "MEMEFI-USDT-SWAP", "PEPEBTC-USDT-SWAP", "bookx-usdt-swap", "CATSETH-USDT-SWAP"],
}.items():
    CASES[_nm] = case(symbols=_alias(_CLS_SRC, _names), trade_cfg=LOOSE, env=OFF_ENV, sweep=200)
CASES["cls_meme_strict"] = case(symbols=_alias(_CLS_SRC, ["PEPE-USDT-SWAP", "DOGE-USDT-SWAP", "BONK-USDT-SWAP",
                                                          "MEME-USDT-SWAP", "ACT-USDT-SWAP"]),
                                trade_cfg=dict(LOOSE, max_risk_pct=1.0), env=OFF_ENV, sweep=200)

# ── working timeframes ──
_TF_SYMS = _same(["SYNRG05-USDT-SWAP", "SYNLV04-USDT-SWAP", "SYNVL03-USDT-SWAP", "BTC-USDT-SWAP"])
CASES["tf15m_default"] = case(tf="15m", window=299, sweep=200, symbols=_TF_SYMS)
CASES["tf15m_loose"] = case(tf="15m", window=299, sweep=400, symbols=_TF_SYMS, trade_cfg=LOOSE)
CASES["tf15m_loose_off"] = case(tf="15m", window=299, sweep=400, symbols=_same(MIX), trade_cfg=LOOSE, env=OFF_ENV)
CASES["tf15m_htf"] = case(tf="15m", window=299, sweep=150, symbols=_TF_SYMS, trade_cfg=dict(LOOSE, use_htf=True), env=OFF_ENV)
CASES["tf30m_default"] = case(tf="30m", window=299, sweep=160, symbols=_TF_SYMS)
CASES["tf30m_loose"] = case(tf="30m", window=299, sweep=300, symbols=_TF_SYMS, trade_cfg=LOOSE)
CASES["tf30m_loose_off"] = case(tf="30m", window=299, sweep=300, symbols=_same(MIX), trade_cfg=LOOSE, env=OFF_ENV)
CASES["tf30m_htf"] = case(tf="30m", window=299, sweep=180, symbols=_TF_SYMS, trade_cfg=dict(LOOSE, use_htf=True), env=OFF_ENV)
CASES["tf4h_default"] = case(tf="4h", sweep=150, symbols=_TF_SYMS)
CASES["tf4h_loose"] = case(tf="4h", sweep=200, symbols=_TF_SYMS, trade_cfg=LOOSE)
CASES["tf4h_loose_off"] = case(tf="4h", sweep=200, symbols=_same(MIX), trade_cfg=LOOSE, env=OFF_ENV)
CASES["tf4h_htf"] = case(tf="4h", window=299, sweep=180, symbols=_TF_SYMS, trade_cfg=dict(LOOSE, use_htf=True), env=OFF_ENV)
CASES["tf1d_default"] = case(tf="1d", sweep=150, symbols=_TF_SYMS)
CASES["tf1d_loose"] = case(tf="1d", sweep=200, symbols=_same(MIX), trade_cfg=LOOSE)
CASES["tf1d_loose_off"] = case(tf="1d", sweep=200, symbols=_TF_SYMS, trade_cfg=LOOSE, env=OFF_ENV)
CASES["tf1d_htf"] = case(tf="1d", sweep=180, symbols=_same(MIX), trade_cfg=dict(LOOSE, use_htf=True), env=OFF_ENV)
CASES["tf1h_win299"] = case(tf="1h", window=299, sweep=160, symbols=_same(MIX), trade_cfg=LOOSE)

# ── BTC/ETH correlation frames ──
for _c in ("none", "btc_only", "short", "stale", "self"):
    CASES[f"corr_{_c}"] = case(sweep=160, symbols=_same(MIX), trade_cfg=LOOSE, env=OFF_ENV, corr=_c)
CASES["corr_tf1h"] = case(tf="15m", window=299, sweep=150, symbols=_same(MIX), trade_cfg=LOOSE, env=OFF_ENV, corr="tf1h")
CASES["corr_self_btc"] = case(sweep=150, symbols=_same(["BTC-USDT-SWAP", "ETH-USDT-SWAP"]), trade_cfg=LOOSE, env=OFF_ENV, corr="self")

# ── modes ──
CASES["mode_hwr_15m"] = case(tf="15m", window=299, sweep=200, symbols=_TF_SYMS, trade_cfg=LOOSE, high_wr=True, env=OFF_ENV)
CASES["mode_hwr_1h"] = case(sweep=150, symbols=_same(MIX), trade_cfg=dict(LOOSE, use_htf=True), high_wr=True, env=OFF_ENV)
CASES["mode_hwr_4h"] = case(tf="4h", sweep=150, symbols=_TF_SYMS, trade_cfg=LOOSE, high_wr=True, env=OFF_ENV)
CASES["mode_hwr_1d"] = case(tf="1d", sweep=180, symbols=_TF_SYMS, trade_cfg=LOOSE, high_wr=True, env=OFF_ENV)
CASES["mode_relaxed"] = case(sweep=150, symbols=_same(MIX), trade_cfg=LOOSE, relaxed=True)
CASES["mode_relaxed_strict"] = case(sweep=150, symbols=_same(RG), relaxed=True)
CASES["mode_relaxed_15m"] = case(tf="15m", window=299, sweep=200, symbols=_TF_SYMS, relaxed=True)
CASES["mode_relax_env"] = case(sweep=150, symbols=_same(MIX), trade_cfg=LOOSE, env=dict(OFF_ENV, LEVELS_RELAX_ENABLED=True))
CASES["mode_relax_env_relaxed"] = case(sweep=180, symbols=_same(RG), env=dict(PROD_ENV, LEVELS_RELAX_ENABLED=True), relaxed=True)
CASES["mode_slv2_ranging"] = case(sweep=180, symbols=_same(MIX), trade_cfg=LOOSE, env=dict(OFF_ENV, SL_V2_LEVELS_ENABLED=True), regime="ranging")
CASES["mode_slv2_trend"] = case(sweep=180, symbols=_same(MIX), trade_cfg=LOOSE, env=dict(OFF_ENV, SL_V2_LEVELS_ENABLED=True), regime="trending_up")
CASES["mode_slv2_volatile_tight"] = case(sweep=180, symbols=_same(MIX), trade_cfg=dict(LOOSE, max_risk_pct=0.5),
                                         env=dict(OFF_ENV, SL_V2_LEVELS_ENABLED=True), regime=" Volatile ")
CASES["mode_regime_no_slv2"] = case(sweep=160, symbols=_same(MIX), trade_cfg=LOOSE, env=OFF_ENV, regime="ranging")
CASES["mode_gates_shadow"] = case(sweep=180, symbols=_same(MIX), trade_cfg=LOOSE,
                                  env=dict(PROD_ENV, LEVELS_REGIME_GATE="shadow", LEVELS_VOL_GATE="shadow", LEVELS_ENTRY_CONFIRM="shadow"))
CASES["mode_vol_enforce"] = case(sweep=180, symbols=_same(MIX), trade_cfg=LOOSE, env=dict(OFF_ENV, LEVELS_VOL_GATE="enforce", LEVELS_MAX_ATR_PCT=0.6))
CASES["mode_confirm_enforce"] = case(sweep=180, symbols=_same(MIX), trade_cfg=LOOSE, env=dict(OFF_ENV, LEVELS_ENTRY_CONFIRM="enforce"))
CASES["mode_all_enforce"] = case(tf="15m", window=299, sweep=150, symbols=_TF_SYMS, trade_cfg=LOOSE,
                                 env=dict(PROD_ENV, LEVELS_VOL_GATE="enforce", LEVELS_ENTRY_CONFIRM="enforce", LEVELS_MAX_ATR_PCT=1.0))
CASES["mode_min_rr_env1"] = case(sweep=180, symbols=_same(MIX), trade_cfg=dict(LOOSE, min_rr=0.8, tp1_rr=1.2), env=dict(OFF_ENV, LEVELS_MIN_RR=1.0))

# ── TradeCfg at the bot-UI / Mini App bounds ──
CASES["cfg_min"] = case(sweep=180, symbols=_same(MIX), env=OFF_ENV, trade_cfg=dict(
    pivot_strength=3, zone_buffer=0.0, zone_pct=0.1, max_dist_pct=0.1, vol_mult=0.05, rsi_ob=60, rsi_os=40, max_risk_pct=0.05,
    min_rr=0.5, tp1_rr=0.3, tp2_rr=0.2, tp3_rr=0.1, cooldown_bars=-3, max_level_tests=1, atr_period=7, rsi_period=7,
    ema_fast=20, ema_slow=100, htf_ema_period=20, use_htf=True, min_quality=-2))
CASES["cfg_min_wide"] = case(sweep=180, symbols=_same(MIX), env=OFF_ENV, trade_cfg=dict(
    pivot_strength=3, zone_buffer=0.0, zone_pct=0.2, max_dist_pct=7.0, vol_mult=0.7, rsi_ob=75, rsi_os=25, max_risk_pct=5.0,
    min_rr=0.8, tp1_rr=1.0, max_level_tests=10, atr_period=7, rsi_period=7, ema_fast=20, ema_slow=100, use_htf=True))
CASES["cfg_max"] = case(sweep=180, symbols=_same(MIX), env=OFF_ENV, trade_cfg=dict(
    pivot_strength=20, zone_buffer=1.0, zone_pct=5.0, max_dist_pct=10.0, vol_mult=9.0, rsi_ob=75, rsi_os=25, max_risk_pct=9.0,
    min_rr=10.0, tp1_rr=100.0, tp2_rr=1.0, tp3_rr=1.0, cooldown_bars=20, max_level_tests=99, atr_period=21, rsi_period=21,
    ema_fast=100, ema_slow=200, htf_ema_period=200, use_htf=True, min_quality=15))
CASES["cfg_ui_max"] = case(sweep=180, symbols=_same(MIX), env=OFF_ENV, trade_cfg=dict(
    pivot_strength=17, zone_buffer=0.7, zone_pct=3.0, max_dist_pct=7.0, vol_mult=2.0, max_risk_pct=3.0, min_rr=5.0,
    tp1_rr=5.0, tp2_rr=8.0, tp3_rr=12.0, max_level_tests=99, use_htf=True, htf_ema_period=100))
CASES["cfg_pivot15"] = case(sweep=180, symbols=_same(RG), env=OFF_ENV, trade_cfg=dict(LOOSE, pivot_strength=15, zone_buffer=0.5))
CASES["cfg_ema500_15m"] = case(tf="15m", window=600, sweep=160, symbols=_same(RG), trade_cfg=dict(LOOSE, ema_slow=500, ema_fast=100))
CASES["cfg_no_filters"] = case(sweep=180, symbols=_same(MIX), env=OFF_ENV, trade_cfg=dict(LOOSE, use_volume=False, use_rsi=False,
                                                                                         use_pattern=True, max_level_tests=99))
CASES["cfg_tp_ladder"] = case(sweep=180, symbols=_same(MIX), env=OFF_ENV, trade_cfg=dict(LOOSE, tp1_rr=4.0, tp2_rr=2.0, tp3_rr=3.0))
CASES["cfg_vol_len"] = case(sweep=150, symbols=_same(MIX), env=OFF_ENV, trade_cfg=dict(LOOSE, vol_len=5, use_volume=True, vol_mult=1.5))
CASES["cfg_loose_vol"] = case(sweep=200, symbols=_same(RG), env=OFF_ENV, trade_cfg=LOOSE_VOL)
CASES["cfg_loose_vol_15m"] = case(tf="15m", window=299, sweep=300, symbols=_TF_SYMS, env=OFF_ENV, trade_cfg=LOOSE_VOL)

# ── degenerate frames ──
CASES["deg_minbars_100"] = case(window=100, sweep=60, symbols=_same(MIX), env=OFF_ENV, trade_cfg=dict(LOOSE, ema_slow=100))
CASES["deg_too_short"] = case(window=150, sweep=30, symbols=_same(MIX[:2]), trade_cfg=dict(ema_slow=200))
CASES["deg_too_short_99"] = case(window=99, sweep=30, symbols=_same(MIX[:2]), trade_cfg=dict(ema_slow=100))
for _w in (50, 54, 55, 60):
    CASES[f"deg_on_demand_{_w}"] = case(window=_w, sweep=80, symbols=_same(MIX), trade_cfg=LOOSE, env=OFF_ENV, call="on_demand")
CASES["deg_on_demand_htf"] = case(window=120, sweep=80, symbols=_same(MIX), trade_cfg=dict(LOOSE, use_htf=True), env=PROD_ENV,
                                  call="on_demand", htf_window=99, corr="none")
for _mn, _mv in {
    "zero_vol": dict(zero_vol_every=7), "zero_vol_dense": dict(zero_vol_every=2),
    "nan_vol": dict(nan_vol_every=11), "nan_vol_dense": dict(nan_vol_every=3),
    "flat": dict(flat_every=3), "const_tail": dict(const_tail=360), "spike": dict(spike_every=13),
    "wick": dict(wick_every=5), "jump": dict(jump_every=17),
    "mixed": dict(zero_vol_every=7, flat_every=11, spike_every=13, jump_every=17, wick_every=19),
}.items():
    CASES[f"deg_{_mn}"] = case(sweep=150, symbols=_same(MIX), trade_cfg=LOOSE_VOL if "vol" in _mn or _mn == "spike" else LOOSE,
                               env=OFF_ENV, mutate=_mv)
CASES["deg_drop"] = case(sweep=160, symbols=_same(MIX), trade_cfg=dict(LOOSE, ema_slow=100), env=OFF_ENV,
                         mutate=dict(drop_every=3, drop_rem=1))
CASES["deg_nan_flat"] = case(sweep=180, symbols=_same(MIX), trade_cfg=LOOSE, env=OFF_ENV, mutate=dict(nan_flat_every=60))
CASES["deg_nan_flat_15m"] = case(tf="15m", window=299, sweep=300, symbols=_TF_SYMS, trade_cfg=LOOSE, env=OFF_ENV,
                                 mutate=dict(nan_flat_every=250))
CASES["deg_nan_vol_novolfilter"] = case(sweep=180, symbols=_same(MIX), trade_cfg=dict(LOOSE, use_volume=False), env=OFF_ENV,
                                        mutate=dict(nan_vol_every=5))
CASES["deg_nan_vol_relaxed"] = case(sweep=150, symbols=_same(MIX), trade_cfg=LOOSE_VOL, relaxed=True, mutate=dict(nan_vol_every=6))
CASES["deg_drop_15m"] = case(tf="15m", window=299, sweep=150, symbols=_TF_SYMS, trade_cfg=LOOSE, env=OFF_ENV,
                             mutate=dict(drop_every=5, drop_rem=2), corr="same")
CASES["deg_const_tail_15m"] = case(tf="15m", window=299, sweep=150, symbols=_TF_SYMS, trade_cfg=LOOSE, env=OFF_ENV,
                                   mutate=dict(const_tail=200))

# price scales (factor applied to OHLC of the working frame and of the 1D HTF frame)
CASES["deg_scale_tiny"] = case(sweep=180, symbols=_same(["SYNRG01-USDT-SWAP", "SYNLV01-USDT-SWAP", "SYNVL01-USDT-SWAP"]),
                               trade_cfg=dict(LOOSE, use_htf=True), env=OFF_ENV, mutate=dict(scale=1e-3))
CASES["deg_scale_huge"] = case(sweep=180, symbols=_same(["SYNRG08-USDT-SWAP", "SYNLV08-USDT-SWAP", "BTC-USDT-SWAP"]),
                               trade_cfg=dict(LOOSE, use_htf=True), env=OFF_ENV, mutate=dict(scale=2.5))


def _psych_factor(src, tf, target):
    """Scale so the median close of the last 300 bars sits exactly on `target` (stored as a float in the case)."""
    df = mg.load_df(OUT_DIR, src, tf)
    med = float(np.median(df["close"].to_numpy()[-300:]))
    return float(target / med)


_PSY = {"psych_1": 1.0, "psych_25": 25.0, "psych_100": 100.0, "psych_1000": 1000.0, "psych_50000": 50000.0}

# ── live path: one persistent indicator per case ──
CASES["live_cooldown_1h"] = case(sweep=150, symbols=_same(MIX), trade_cfg=dict(LOOSE, cooldown_bars=3), env=OFF_ENV,
                                 mode="live", clock_step=3600)
CASES["live_cooldown_gaps"] = case(sweep=160, symbols=_same(MIX), trade_cfg=dict(LOOSE, cooldown_bars=3, ema_slow=100), env=OFF_ENV,
                                   mode="live", clock_step=3600, mutate=dict(drop_every=3, drop_rem=1))
CASES["live_cooldown_gaps5"] = case(sweep=190, symbols=_same(MIX), trade_cfg=dict(LOOSE, cooldown_bars=5, ema_slow=100), env=OFF_ENV,
                                    mode="live", clock_step=3600, mutate=dict(drop_every=4, drop_rem=2))
CASES["live_cooldown_gaps_relaxed"] = case(sweep=180, symbols=_same(MIX + RG[:2]), relaxed=True, mode="live", clock_step=3600,
                                           trade_cfg=dict(LOOSE, cooldown_bars=3, ema_slow=100),
                                           mutate=dict(drop_every=3, drop_rem=1, wick_every=7, spike_every=5))
CASES["live_cooldown_gaps_15m"] = case(tf="15m", window=299, sweep=400, symbols=_TF_SYMS, relaxed=True, mode="live",
                                       clock_step=900, trade_cfg=dict(LOOSE, cooldown_bars=3),
                                       mutate=dict(drop_every=3, drop_rem=1, wick_every=7))
CASES["live_on_demand"] = case(window=120, sweep=180, symbols=_same(MIX), trade_cfg=LOOSE, env=OFF_ENV, mode="live",
                               clock_step=500, call="on_demand")
CASES["live_cache_1h"] = case(sweep=150, symbols=_same(MIX), trade_cfg=dict(LOOSE, cooldown_bars=0), env=OFF_ENV,
                              mode="live", clock_step=600)
CASES["live_cache_prefilter"] = case(sweep=150, symbols=_same(MIX), trade_cfg=dict(LOOSE, max_dist_pct=0.5, cooldown_bars=1),
                                     env=OFF_ENV, mode="live", clock_step=400)
CASES["live_cache_evict"] = case(sweep=180, symbols=_same(MIX), trade_cfg=dict(LOOSE, cooldown_bars=2), env=OFF_ENV,
                                 mode="live", clock_step=700, cache_max=2)
CASES["live_cache_15m"] = case(tf="15m", window=299, sweep=200, symbols=_TF_SYMS, trade_cfg=dict(LOOSE, cooldown_bars=2),
                               mode="live", clock_step=250)
CASES["live_cache_1d"] = case(tf="1d", sweep=180, symbols=_same(MIX), trade_cfg=dict(LOOSE, cooldown_bars=1, use_htf=True),
                              env=OFF_ENV, mode="live", clock_step=3000)
CASES["live_htf_cache"] = case(sweep=150, symbols=_same(MIX), trade_cfg=dict(LOOSE, use_htf=True, cooldown_bars=2), env=OFF_ENV,
                               mode="live", clock_step=3600)
CASES["live_relaxed_15m"] = case(tf="15m", window=299, sweep=200, symbols=_TF_SYMS, relaxed=True, mode="live", clock_step=900,
                                 trade_cfg=dict(cooldown_bars=1))
CASES["live_relaxed_fast"] = case(sweep=150, symbols=_same(MIX), relaxed=True, mode="live", clock_step=1200,
                                  trade_cfg=dict(LOOSE, cooldown_bars=0), mutate=dict(spike_every=5, wick_every=7))

# ── 44 seeded random valid configs ──
UI = {
    "pivot_strength": [3, 5, 7, 10, 15, 17, 20], "zone_buffer": [0.0, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0],
    "ema_fast": [20, 50, 100], "ema_slow": [100, 200], "htf_ema_period": [20, 50, 100, 200], "rsi_period": [7, 14, 21],
    "rsi_ob": [60, 65, 70, 75], "rsi_os": [25, 30, 35, 40], "vol_mult": [0.7, 1.0, 1.2, 1.5, 2.0], "atr_period": [7, 14, 21],
    "atr_mult": [0.5, 1.0, 1.5, 2.0], "max_risk_pct": [0.5, 1.0, 1.5, 2.0, 3.0],
    "cooldown_bars": [0, 1, 2, 3, 5, 8, 10, 15, 20], "max_level_tests": [1, 2, 3, 4, 5, 6, 7, 8, 10, 99],
    "zone_pct": [0.2, 0.3, 0.5, 0.7, 1.0, 1.2, 1.35, 1.5, 2.0, 2.5, 3.0],
    "max_dist_pct": [0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 7.0],
    "min_rr": [0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0], "max_level_age": [30, 50, 75, 100, 142, 150, 200, 250, 300],
    "max_retest_bars": [10, 20, 30, 50], "min_quality": [1, 2, 3, 4, 5],
}
MINIAPP_FLOAT = {"zone_pct": (0.1, 5.0), "max_dist_pct": (0.1, 10.0), "min_rr": (0.5, 10.0), "max_risk_pct": (0.1, 5.0)}
ALIASES = ["PEPE-USDT-SWAP", "DOGE-USDT-SWAP", "WIF-USDT-SWAP", "BTC-USDT-SWAP", "ETH-USDT-SWAP", "ETHFI-USDT-SWAP",
           "SOL-USDT-SWAP", "XRP-USDT-SWAP", "AVAX-USDT-SWAP", "FACT-USDT-SWAP", "TIA-USDT-SWAP", "SHIB-USDT-SWAP"]


def random_case(rng):
    tc = {}
    for k, vals in UI.items():
        if rng.random() < 0.75:
            tc[k] = rng.choice(vals)
    for k, (lo, hi) in MINIAPP_FLOAT.items():
        if rng.random() < 0.25:
            tc[k] = round(rng.uniform(lo, hi), 2)
    if rng.random() < 0.5:
        tc["tp1_rr"] = rng.choice([0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 5.0])
        tc["tp2_rr"] = rng.choice([1.0, 2.0, 3.0, 4.0, 6.0])
        tc["tp3_rr"] = rng.choice([2.0, 3.0, 4.5, 6.0, 9.0])
    for k in ("use_rsi", "use_volume", "use_pattern", "use_htf"):
        if rng.random() < 0.4:
            tc[k] = rng.random() < 0.5
    tf = rng.choices(["1h", "15m", "4h", "30m", "1d"], weights=[45, 20, 15, 12, 8])[0]
    window = 299 if tf in ("15m", "30m") else rng.choice([None, 299])
    env = dict(PROD_ENV)
    if rng.random() < 0.4:
        env["LEVELS_REGIME_GATE"] = rng.choice(["off", "shadow"])
    if rng.random() < 0.12:
        env["LEVELS_VOL_GATE"] = rng.choice(["enforce", "shadow"])
        env["LEVELS_MAX_ATR_PCT"] = rng.choice([0.8, 1.5, 2.5])
    if rng.random() < 0.12:
        env["LEVELS_ENTRY_CONFIRM"] = rng.choice(["enforce", "shadow"])
    if rng.random() < 0.1:
        env["LEVELS_RELAX_ENABLED"] = True
    regime = None
    if rng.random() < 0.15:
        env["SL_V2_LEVELS_ENABLED"] = True
        regime = rng.choice(["ranging", "trending_down", "high_vol", "volatile", "range"])
    srcs = rng.sample(ALL_SRC, 4)
    names = rng.sample(ALIASES, 4) if rng.random() < 0.6 else srcs
    return case(tf=tf, window=window, sweep=90 if tf in ("15m", "30m") else 80, symbols=_alias(srcs, names), trade_cfg=tc,
                high_wr=rng.random() < 0.2, env=env, regime=regime, relaxed=rng.random() < 0.15,
                corr=rng.choice(["same", "same", "same", "none", "btc_only", "short", "stale"]))


# ────────────────────────────────────────────────────────────────────────────
# Frames
# ────────────────────────────────────────────────────────────────────────────
_FRAMES = {}


def base_frame(src, tf):
    """Working-TF frame of a fixture symbol; 30m = pairs of 15m bars (open first, high max, low min, close last, vol sum)."""
    key = (src, tf)
    if key not in _FRAMES:
        if tf == "30m":
            d = base_frame(src, "15m")
            n = len(d) // 2 * 2
            o, h, l, c, v = (d[k].to_numpy()[:n] for k in ("open", "high", "low", "close", "volume"))
            import pandas as pd
            df = pd.DataFrame({"open": o[0::2], "high": np.maximum(h[0::2], h[1::2]), "low": np.minimum(l[0::2], l[1::2]),
                               "close": c[1::2], "volume": v[0::2] + v[1::2]}, index=d.index[:n][0::2])
            df.index.name = "open_time"
            _FRAMES[key] = df
        else:
            _FRAMES[key] = mg.load_df(OUT_DIR, src, tf)
    return _FRAMES[key]


def mutate(df, mut):
    """Deterministic candle mutation (index j counted AFTER the row drop) — mirrored in probe.test.js."""
    if not mut:
        return df
    if mut.get("drop_every"):
        k, r = mut["drop_every"], mut.get("drop_rem", 0)
        keep = np.array([j % k != r for j in range(len(df))])
        df = df.iloc[keep]
    df = df.copy()
    o, h, l, c, v = (df[k].to_numpy().copy() for k in ("open", "high", "low", "close", "volume"))
    n = len(df)
    jp, fl, sp, zv, nv, wk, nf = (mut.get(k) for k in ("jump_every", "flat_every", "spike_every", "zero_vol_every",
                                                        "nan_vol_every", "wick_every", "nan_flat_every"))
    factor = 1.0
    for j in range(n):
        if jp and j % jp == 9:
            factor *= 1.04 if (j // jp) % 2 == 0 else 0.96
        if jp:
            o[j] *= factor; h[j] *= factor; l[j] *= factor; c[j] *= factor
        if wk and j % wk == 6:
            l[j] = l[j] - (h[j] - l[j]) * 2.0
        if wk and j % wk == 0:
            h[j] = h[j] + (h[j] - l[j]) * 2.0
        if fl and j % fl == 5:
            o[j] = c[j]; h[j] = c[j]; l[j] = c[j]
        if sp and j % sp == 2:
            v[j] *= 40.0
        if zv and j % zv == 3:
            v[j] = 0.0
        if nv and j % nv == 4:
            v[j] = float("nan")
        if nf and j % nf == 7:          # a flat bar (spans no volume-profile bin centre) with a NaN volume
            o[j] = c[j]; h[j] = c[j]; l[j] = c[j]; v[j] = float("nan")
    ct = mut.get("const_tail")
    if ct:
        p = c[n - ct - 1]
        for j in range(n - ct, n):
            o[j] = p; h[j] = p; l[j] = p; c[j] = p
    s = mut.get("scale")
    if s:
        o = o * s; h = h * s; l = l * s; c = c * s
    return df.assign(open=o, high=h, low=l, close=c, volume=v)


def scale_frame(df, s):
    if not s:
        return df
    return df.assign(open=df["open"].to_numpy() * s, high=df["high"].to_numpy() * s, low=df["low"].to_numpy() * s,
                     close=df["close"].to_numpy() * s)


def aligned(df, tf, close_ms, window):
    """Bars of df closed at close_ms (open + tf <= close_ms), last `window`; None when empty."""
    n = int(np.searchsorted(mg.open_ms(df) + TF_MS[tf], close_ms, side="right"))
    sub = df.iloc[:n]
    if window:
        sub = sub.iloc[-window:]
    return sub if len(sub) else None


def corr_frames(mode, tf, close_ms, df):
    if mode == "none":
        return None, None
    ctf = "1h" if mode == "tf1h" else tf
    btc, eth = base_frame("BTC-USDT-SWAP", ctf), base_frame("ETH-USDT-SWAP", ctf)
    if mode == "stale":
        return aligned(btc, ctf, close_ms - 40 * TF_MS[ctf], CORR_WINDOW), aligned(eth, ctf, close_ms - 40 * TF_MS[ctf], CORR_WINDOW)
    b, e = aligned(btc, ctf, close_ms, CORR_WINDOW), aligned(eth, ctf, close_ms, CORR_WINDOW)
    if mode == "btc_only":
        return b, None
    if mode == "short":
        return aligned(btc, ctf, close_ms, 10), aligned(eth, ctf, close_ms, 11)
    if mode == "self":
        return df, e
    return b, e


# ────────────────────────────────────────────────────────────────────────────
# Live state of the bot (injected per case)
# ────────────────────────────────────────────────────────────────────────────
class FakeClock:
    """Replaces the `time` module inside indicator.py / momentum_detector.py (zone cache TTL, ATR-breakout cooldown)."""

    def __init__(self):
        self.t = 0.0

    def time(self):
        return self.t


CLOCK = FakeClock()


def apply_env(spec):
    import indicator
    import market_regime
    import momentum_detector as md
    from config import Config
    env = spec["env"]
    Config.LEVELS_REGIME_GATE = env["LEVELS_REGIME_GATE"]
    Config.LEVELS_VOL_GATE = env["LEVELS_VOL_GATE"]
    Config.LEVELS_ENTRY_CONFIRM = env["LEVELS_ENTRY_CONFIRM"]
    Config.LEVELS_MAX_ATR_PCT = float(env["LEVELS_MAX_ATR_PCT"])
    Config.LEVELS_MIN_RR = float(env["LEVELS_MIN_RR"])
    os.environ["LEVELS_RELAX_ENABLED"] = "1" if env["LEVELS_RELAX_ENABLED"] else "0"
    os.environ["SL_V2_LEVELS_ENABLED"] = "1" if env["SL_V2_LEVELS_ENABLED"] else "0"
    market_regime._cached_regime = spec["regime"]
    market_regime._cached_at = time.time()      # real clock: market_regime keeps its own time module
    indicator.time = CLOCK
    md.time = CLOCK
    md._state.relaxed = spec["relaxed"]
    md._state.relaxed_until = 1e18 if spec["relaxed"] else 0.0
    md._state.trigger_reason = TRIGGER
    md._last_breakout_alert.clear()


def run_case(name):
    import indicator
    import momentum_detector as md
    from indicator import CHMIndicator, reset_analyze_stats, get_analyze_stats
    from scanner_mid import _cfg_to_ind
    from user_manager import TradeCfg
    from squeeze_detector import compute_squeeze_score
    spec = CASES[name]
    apply_env(spec)
    tc = TradeCfg(**spec["trade_cfg"])
    ic = _cfg_to_ind(tc, high_wr_mode=spec["high_wr"])
    min_q = md.relax_min_quality(tc.min_quality)
    tf, W, mut = spec["tf"], spec["window"], spec["mutate"]
    scale = (mut or {}).get("scale")
    syms = []
    for src, alias in spec["symbols"]:
        base = mutate(base_frame(src, tf), mut)
        n = len(base)
        idx = list(range(n - spec["sweep"], n, spec["step"]))
        if idx[-1] != n - 1:
            idx.append(n - 1)
        syms.append(dict(src=src, alias=alias, base=base, oms=mg.open_ms(base), idx=idx,
                         htf=scale_frame(base_frame(src, "1d"), scale), signals=[], rejects={}, errors=[], warnings=0))
    live = spec["mode"] == "live"
    shared = CHMIndicator(ic) if live else None
    if live and spec["cache_max"]:
        shared._ZONE_CACHE_MAX = spec["cache_max"]
    n_steps = max(len(s["idx"]) for s in syms)
    t0 = (int(syms[0]["oms"][syms[0]["idx"][0]]) + TF_MS[tf]) / 1000.0
    for k in range(n_steps):
        for s in syms:
            if k >= len(s["idx"]):
                continue
            i = s["idx"][k]
            base = s["base"]
            df = base.iloc[max(0, i - W + 1):i + 1] if W else base.iloc[:i + 1]
            close_ms = int(s["oms"][i]) + TF_MS[tf]
            df_htf = aligned(s["htf"], "1d", close_ms, spec["htf_window"]) if tc.use_htf else None
            btc, eth = corr_frames(spec["corr"], tf, close_ms, df)
            if live:
                CLOCK.t = t0 + k * spec["clock_step"]
                ind = shared
            else:
                CLOCK.t = close_ms / 1000.0
                md._last_breakout_alert.clear()
                ind = CHMIndicator(ic)
            reset_analyze_stats()
            mg._CAP.records.clear()
            try:
                if spec["call"] == "on_demand":
                    sig = ind.analyze_on_demand(s["alias"], df, df_htf, btc, eth)
                else:
                    sig = ind.analyze(s["alias"], df, df_htf, btc, eth)
            except Exception as e:  # noqa: BLE001
                s["errors"].append(dict(i=i, error=f"{type(e).__name__}: {e}"))
                continue
            if mg._CAP.records:
                s["warnings"] += len(mg._CAP.records)
            if sig is None:
                st = get_analyze_stats()
                s["rejects"][str(i)] = ",".join(sorted(st)) if st else "none"
                continue
            if live:
                ind.mark_signal(s["alias"], df)
            d = dc.asdict(sig)
            sq = int(compute_squeeze_score(df) or 0)
            q_after = min(d["quality"] + 1, 10) if sq >= 1 else d["quality"]
            d.update(i=i, open_time_ms=int(s["oms"][i]), n_bars=len(df), n_htf_bars=(len(df_htf) if df_htf is not None else 0),
                     squeeze_score=sq, quality_after_squeeze=q_after, passes_min_quality=bool(q_after >= min_q))
            s["signals"].append(mg.r10(d))
    out = dict(spec, trade_cfg_full=mg.r10(dc.asdict(tc)), ind_config=mg.r10(dc.asdict(ic)), min_quality_eff=min_q, fixtures={})
    for s in syms:
        out["fixtures"][s["alias"]] = dict(src=s["src"], swept=[s["idx"][0], s["idx"][-1], spec["step"]], n_swept=len(s["idx"]),
                                           n_signals=len(s["signals"]), signals=s["signals"], rejects=s["rejects"],
                                           errors=s["errors"], warnings=s["warnings"])
    return name, out


def _init_worker():
    mg._attach_capture()


def build_cases():
    global ALL_SRC
    with open(os.path.join(OUT_DIR, "candles", "index.json")) as fh:
        ALL_SRC = [f["symbol"] for f in json.load(fh)["fixtures"]]
    srcs = {"psych_1": "SYNRG03-USDT-SWAP", "psych_25": "SYNRG05-USDT-SWAP", "psych_100": "SYNRG06-USDT-SWAP",
            "psych_1000": "SYNLV07-USDT-SWAP", "psych_50000": "SYNRG08-USDT-SWAP"}
    for nm, target in _PSY.items():
        src = srcs[nm]
        CASES[f"deg_{nm}"] = case(sweep=180, symbols=[[src, src], ["SYNLV04-USDT-SWAP", "SYNLV04-USDT-SWAP"]],
                                  trade_cfg=dict(LOOSE, use_htf=True), env=OFF_ENV,
                                  mutate=dict(scale=_psych_factor(src, "1h", target)))
    rng = random.Random(20261008)
    for k in range(44):
        CASES[f"rand{k:02d}"] = random_case(rng)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", default=None, help="debug: comma-separated case-name prefixes (nothing is written)")
    ap.add_argument("--workers", type=int, default=int(os.environ.get("GOLDEN_PROBE_WORKERS", "4")))
    args = ap.parse_args()
    import logging
    logging.basicConfig(level=logging.ERROR)
    build_cases()
    import pandas as pd
    import scipy
    names = list(CASES)
    if args.cases:
        pref = tuple(x.strip() for x in args.cases.split(",") if x.strip())
        names = [n for n in names if n.startswith(pref)]
    t_all = time.time()
    import multiprocessing as mp
    if args.workers > 1:
        with mp.get_context("fork").Pool(args.workers, initializer=_init_worker) as pool:
            results = dict(pool.imap_unordered(run_case, names))
    else:
        _init_worker()
        results = dict(run_case(n) for n in names)
    cases = {n: results[n] for n in names}
    for junk in ("signal_registry.json",):
        p = os.path.join(mg.BOT_DIR, junk)
        if os.path.exists(p):
            os.remove(p)
    tot = lambda key: sum(len(f[key]) if isinstance(f[key], (list, dict)) else f[key]  # noqa: E731
                          for c in cases.values() for f in c["fixtures"].values())
    n_bars, n_sig, n_rej, n_err = tot("n_swept"), tot("n_signals"), tot("rejects"), tot("errors")
    reasons = {}
    for c in cases.values():
        for f in c["fixtures"].values():
            for r in f["rejects"].values():
                reasons[r] = reasons.get(r, 0) + 1
    print(f"{len(cases)} cases, {n_bars} bars, {n_sig} signals, {n_rej} null bars, {n_err} errors, "
          f"{time.time() - t_all:.1f}s; rejects {dict(sorted(reasons.items()))}", flush=True)
    if args.cases:
        for n, c in cases.items():
            print(f"  {n:<26} " + " ".join(f"{a}:{f['n_signals']}/{f['n_swept']}" for a, f in c["fixtures"].items()))
        return 0
    doc = {"probe": "levels", "python": sys.version.split()[0], "pandas": pd.__version__, "numpy": np.__version__,
           "scipy": scipy.__version__, "trigger_reason": TRIGGER, "corr_window": CORR_WINDOW,
           "call": "fresh: ind = CHMIndicator(_cfg_to_ind(TradeCfg(**trade_cfg), high_wr)) per bar; live: one instance per case, "
                   "bars outer / symbols inner, clock = t0 + k*clock_step, mark_signal(alias, df) after every signal; "
                   "sig = ind.analyze(alias, df, df_htf, btc, eth) or ind.analyze_on_demand(...)",
           "cases": cases}
    raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    with gzip.GzipFile(os.path.join(OUT_DIR, "levels_probe.json.gz"), "wb", mtime=0) as fh:
        fh.write(raw)
    summary = {"probe": "levels", "cases": len(cases), "bars": n_bars, "signals": n_sig, "null_bars": n_rej, "errors": n_err,
               "reject_reasons": dict(sorted(reasons.items())),
               "per_case": {k: {"signals": sum(f["n_signals"] for f in v["fixtures"].values()),
                                "bars": sum(f["n_swept"] for f in v["fixtures"].values())} for k, v in cases.items()},
               "sha256": {"levels_probe.json": hashlib.sha256(raw).hexdigest()},
               "elapsed_s": round(time.time() - t_all, 1)}
    with open(os.path.join(OUT_DIR, "levels_probe_summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1, ensure_ascii=False)
    print(f"wrote levels_probe.json.gz ({len(raw)} bytes raw)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
