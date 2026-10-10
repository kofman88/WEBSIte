#!/usr/bin/env python
"""make_golden.py — golden test fixtures for the JS port of the CHM bot strategies.

Produces, deterministically (fixed numpy seeds, no network, no DB, no Telegram):

  candles/<SYMBOL>_<tf>.json      synthetic OHLCV series (15m / 1h / 4h / 1d)
  candles/index.json              fixture metadata (regime, seed, beta, events)
  expected/levels.json            CHMIndicator.analyze()  (indicator.py)   per bar / per variant
  expected/smc.json               SMCAnalyzer.analyze() + build_smc_signal() per bar / per variant
  expected/smc_analysis.json      per-bar digest of the SMC analysis dict (default variant)
  expected/volume.json            volume_strategy.analyze_volume()         per bar / per variant
  summary.json                    counts + notes

Usage (from anywhere):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 python make_golden.py [--fixtures N] [--workers 4] [--step 1]

The script chdir()s into the bot directory (the bot's modules resolve relative paths from cwd)
and removes signal_registry.json afterwards if one was created.

Nothing in the bot repository is modified.
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import logging
import math
import os
import sys
import time
from typing import Optional

# ────────────────────────────────────────────────────────────────────────────
# Environment / paths
# ────────────────────────────────────────────────────────────────────────────
BOT_DIR = os.environ.get("GOLDEN_BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.environ.get("GOLDEN_OUT_DIR", HERE)

os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
# Make every env-driven flag explicit (these are the production defaults from config.py /
# sl_v2.py / squeeze_detector.py / indicator.py) so a re-run cannot be influenced by the shell.
_PINNED_ENV = {
    "LEVELS_REGIME_GATE": "enforce",   # config.py default → levels_filters.regime gate ON
    "LEVELS_VOL_GATE": "off",
    "LEVELS_ENTRY_CONFIRM": "off",
    "LEVELS_MAX_ATR_PCT": "2.5",
    "LEVELS_MIN_RR": "1.8",
    "LEVELS_RELAX_ENABLED": "0",
    "SL_V2_SMC_ENABLED": "0",
    "SL_V2_LEVELS_ENABLED": "0",
    "SQUEEZE_BB_LOOKBACK": "50",
    "SQUEEZE_BB_PCTILE_STRONG": "15",
    "SQUEEZE_BB_PCTILE_SOME": "30",
    "SQUEEZE_ATR_RATIO_STRONG": "0.7",
    "SQUEEZE_ATR_RATIO_SOME": "0.85",
    "CACHE_FIRST_MODE": "off",
}
for _k, _v in _PINNED_ENV.items():
    os.environ[_k] = _v
# [VOL-MIN-SL] / [VOL-MIN-VOLUME] / [VOL-LIQ-15M] / [VOL-POST-SL-PAUSE] 2026-10 (bot batch D): the VOLUME
# env thresholds are UNSET = their production defaults (15m stop floor 1 %, setup volume ×1.5, …). Not
# recorded under `env` (that record is shared by every expected file and the LEVELS / SMC ones stay
# byte-identical); volume.json carries them as `volume_env`.
_UNSET_ENV = ("VOLUME_MIN_SL_PCT_15M", "VOLUME_MIN_SETUP_VOL_MULT", "VOLUME_15M_COINS_FLOOR_USDT", "VOLUME_POST_SL_PAUSE_BARS")
for _k in _UNSET_ENV:
    os.environ.pop(_k, None)

sys.dont_write_bytecode = True           # never leave .pyc files behind in the bot repo
sys.path.insert(0, BOT_DIR)
os.chdir(BOT_DIR)

import numpy as np   # noqa: E402
import pandas as pd  # noqa: E402

# ────────────────────────────────────────────────────────────────────────────
# Candle generator
# ────────────────────────────────────────────────────────────────────────────
T_END = pd.Timestamp("2026-01-01 00:00:00")      # naive UTC; last bar of every TF closes here
N_DAYS = 400
BARS_15M = N_DAYS * 96                            # 38 400 base bars
SUB = 4                                           # sub-steps per 15m bar (for realistic H/L)
TF_MS = {"15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
TF_RULE = {"1h": "1h", "4h": "4h", "1d": "1D"}
STORE_BARS = {"15m": 2000, "1h": 400, "4h": 400, "1d": 400}   # 15m is longer: SMC LTF window must exist for every 1h sweep bar

# Per regime: the price path is a LEG sequence (impulse → V-reversal → consolidation / pullback / retest, see
# _legs) tracked by a fast OU noise (kn) with volatility clustering; sigma is the 15m noise, jp/js jump
# prob/size, vmult/sp volume level & spike probability. This yields what the strategies look for: fast arrivals
# at old pivots with an immediate reaction (LEVELS), BOS + order blocks + FVG retraces (SMC), MA crosses and
# EMA pullbacks with volume (VOLUME).
REGIME_PARAMS = {
    "trending_up":   dict(mu=+1.0, sigma=0.0016, kn=0.08, jp=0.002,  js=0.010, vmult=1.0,  sp=0.010),
    "trending_down": dict(mu=-1.0, sigma=0.0018, kn=0.08, jp=0.003,  js=0.012, vmult=1.1,  sp=0.012),
    "ranging":       dict(mu=0.0,  sigma=0.0014, kn=0.08, jp=0.001,  js=0.008, vmult=0.9,  sp=0.008),
    "volatile":      dict(mu=0.0,  sigma=0.0032, kn=0.08, jp=0.010,  js=0.022, vmult=1.4,  sp=0.018),
    "low_volume":    dict(mu=0.0,  sigma=0.0011, kn=0.08, jp=0.0005, js=0.006, vmult=0.25, sp=0.003),
}
REGIME_CODE = {"trending_up": "UP", "trending_down": "DN", "ranging": "RG", "volatile": "VL", "low_volume": "LV"}
PRICE_SCALES = [0.00012, 0.045, 0.85, 3.2, 27.0, 150.0, 2400.0, 65000.0]
BETAS = [0.0, 0.4, 0.8]


def _fixture_specs(limit: Optional[int] = None) -> list[dict]:
    specs = [
        dict(symbol="BTC-USDT-SWAP", regime="market", seed=1000, beta=0.0, price=90_000.0, base_vol=4.0e7, memcoin=False),
        dict(symbol="ETH-USDT-SWAP", regime="market", seed=1001, beta=0.9, price=3_100.0, base_vol=1.5e7, memcoin=False),
    ]
    ri = 0
    for regime, code in REGIME_CODE.items():
        for k in range(8):
            name = f"SYN{code}{k + 1:02d}"
            memcoin = False
            if regime == "volatile" and k == 6:
                name, memcoin = "PEPEVL07", True
            if regime == "volatile" and k == 7:
                name, memcoin = "DOGEVL08", True
            specs.append(dict(
                symbol=f"{name}-USDT-SWAP", regime=regime, seed=100 * (ri + 1) + k,
                beta=(0.0 if regime == "low_volume" else BETAS[k % 3]), price=PRICE_SCALES[k],
                base_vol=float([3e5, 8e5, 2e6, 5e6, 1.2e6, 3e6, 7e5, 2.5e6][k]), memcoin=memcoin,
            ))
        ri += 1
    if limit:
        specs = specs[:limit]
    return specs


def _regime_schedule(rng: np.random.Generator, named: str) -> list[tuple[int, int, str]]:
    """Segments (start_bar, end_bar, regime). The named regime governs the final 30 days."""
    segs = []
    final_days = 30
    cut = BARS_15M - final_days * 96
    pos = 0
    names = list(REGIME_PARAMS)
    while pos < cut:
        length = int(rng.integers(10, 41)) * 96
        reg = names[int(rng.integers(0, len(names)))]
        end = min(cut, pos + length)
        segs.append((pos, end, reg))
        pos = end
    if named == "market":
        # BTC/ETH: a mixed tail too
        p = cut
        while p < BARS_15M:
            length = int(rng.integers(8, 16)) * 96
            reg = names[int(rng.integers(0, len(names)))]
            end = min(BARS_15M, p + length)
            segs.append((p, end, reg)); p = end
    else:
        segs.append((cut, BARS_15M, named))
    return segs


def _ramp(n: int, size: float, shape: str = "accel") -> np.ndarray:
    """Cumulative path of `size` over n bars (starts at 0 excl., ends at size)."""
    t = np.linspace(0.0, 1.0, n + 1)[1:]
    if shape == "accel":      # slow start, fast finish — impulse arriving at a level
        f = t ** 1.6
    elif shape == "decel":    # fast start, slow finish — rejection fading out
        f = 1.0 - (1.0 - t) ** 1.8
    else:
        f = t
    return size * f


def _legs(rng: np.random.Generator, reg: str, length: int, mu_scale: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Target log-path (relative, starts at 0), a volume-shape multiplier and a noise multiplier, per 15m bar."""
    path = np.zeros(length); vshape = np.ones(length); nmul = np.ones(length)
    pos = 0; x = 0.0
    U = rng.uniform
    legs: list[tuple[int, str]] = []        # (start bar, name) — annotation only

    def put(seg: np.ndarray, vmul: float, noise: float = 1.0):
        nonlocal pos, x
        n = min(len(seg), length - pos)
        if n <= 0:
            return
        path[pos:pos + n] = x + seg[:n]
        vshape[pos:pos + n] = vmul
        nmul[pos:pos + n] = noise
        x = x + seg[n - 1]
        pos += n

    def impulse(size: float, speed: float, noise: float = 1.0):
        n = max(4, -4 * (-int(abs(size) / speed) // 4))     # whole hours → every leg stays aligned to the 1h bars
        put(_ramp(n, size, "accel"), U(1.4, 2.4), noise)

    def reversal(size: float, noise: float = 1.0):
        n = int(U(2, 6)) * 4                       # 2–6 hours, fast
        put(_ramp(n, size, "decel"), U(2.0, 3.5), noise)
        vshape[max(0, pos - n)] *= U(1.3, 2.0)       # the reaction bar gets the spike

    def consolidation(bars_1h: tuple[int, int], amp: float = 0.003, noise: float = 1.0, vol: tuple[float, float] = (0.55, 0.8)):
        n = int(U(*bars_1h)) * 4
        wig = amp * np.sin(np.linspace(0, U(1.0, 3.0) * math.pi, n) + U(0, math.pi)) * U(0.5, 1.0)
        put(wig - wig[-1] * np.linspace(0, 1, n), U(*vol), noise)

    def drift(size: float, bars_1h: tuple[int, int]):
        n = int(U(*bars_1h)) * 4
        put(_ramp(n, size, "lin"), U(0.7, 0.9))

    def quiet(side: float):
        """Quiet market with repeated liquidity sweeps of ONE equal-low (side=+1) / equal-high (side=-1) level —
        the only structure that passes every LEVELS gate at once:
          * impulse to a fresh extreme, then back off it (nothing structural in the way of mechanical TPs);
          * a strictly monotonic micro-drift (-0.04 %/cycle, noise ≈ 0) so the quiet phase itself creates NO
            pivots (a flat consolidation clusters into zones that are picked first and fail approach quality);
          * 8–11 cycles of (22–38 h drift, 2-bar sweep to the level, 1-bar reversal with a volume spike): sweep
            depth 1.0–1.3 % keeps the 25-bar EMA50 drift < 0.1 % (market_regime stays 'ranging' after ~150 bars);
          * later sweeps may overshoot by 0.4 / 0.8 % → fakeout / SFP / LIQUIDITY_SWEEP variants."""
        legs.append((pos, f"quiet_sfp side={int(side)}"))
        impulse(side * U(0.03, 0.045), U(0.0010, 0.0020))
        put(_ramp(int(U(16, 28)) * 4, -side * U(0.02, 0.03), "decel"), U(0.6, 0.9), 0.005)
        x0 = x
        level = x0 - side * U(0.0095, 0.0135)            # sweep extreme (fixed for the whole leg); depth grows 0.04 %/cycle
        cycles = int(U(8, 11))
        drift_per_cycle = U(0.0003, 0.0006)
        for k in range(cycles):
            extra = 0.0 if k < 3 else float(rng.choice([0.0, 0.0, 0.004, 0.008]))
            legs.append((pos, f"sweep k={k} extra={extra}"))
            put(_ramp(int(U(22, 38)) * 4, -side * drift_per_cycle, "lin"), U(0.5, 0.75), 0.005)
            tgt = level - side * extra
            line = x
            if rng.random() < 0.6:                       # 2-bar dip + 1-bar reversal (engulfing / order block)
                put(_ramp(8, tgt - x, "accel"), U(1.4, 2.0), 0.005)
                put(_ramp(4, line - x, "decel"), U(2.5, 4.0), 0.005)
            else:                                        # V inside one bar (pin bar / fakeout pin bar)
                put(_ramp(2, tgt - x, "accel"), U(2.5, 4.0), 0.005)
                put(_ramp(2, line + side * 0.00003 - x, "decel"), U(2.5, 4.0), 0.005)   # closes a hair above the open: pin bar, no pivot high

    if reg in ("ranging", "low_volume"):
        width = U(0.05, 0.08) if reg == "ranging" else U(0.03, 0.05)
        L = x - width * U(0.3, 0.7); H = L + width
        side = "L" if abs(x - H) < abs(x - L) else "H"   # start by going to the farther boundary
        p_quiet = 0.4 if reg == "ranging" else 0.7
        while pos < length:
            if rng.random() < p_quiet:
                quiet(1.0 if rng.random() < 0.5 else -1.0)
                consolidation((6, 24))
                continue
            tgt = H if side == "L" else L
            sgn = 1.0 if tgt > x else -1.0
            legs.append((pos, f"range_leg to {'H' if tgt == H else 'L'}"))
            if rng.random() < 0.5:                        # mid-range stop first
                impulse(0.5 * (tgt - x) + sgn * U(-0.004, 0.004), U(0.0010, 0.0020))
                consolidation((12, 40))
            over = sgn * U(0.002, 0.006) if rng.random() < 0.45 else 0.0
            impulse(tgt + sgn * U(-0.003, 0.003) + over - x, U(0.0010, 0.0022))
            reversal(-over - sgn * U(0.006, 0.014))
            if rng.random() < 0.35:                       # retest of the same level, fast
                consolidation((4, 12))
                impulse(tgt - x + sgn * U(-0.002, 0.002), U(0.0010, 0.0020))
                reversal(-sgn * U(0.006, 0.012))
            consolidation((8, 48))
            side = "H" if side == "L" else "L"
    elif reg in ("trending_up", "trending_down"):
        d = 1.0 if reg == "trending_up" else -1.0
        while pos < length:
            size = d * U(0.03, 0.07) * (1.0 if mu_scale == 1.0 else 0.75)
            origin = x
            legs.append((pos, "trend_impulse"))
            impulse(size, U(0.0010, 0.0025))
            if rng.random() < 0.4:
                reversal(-d * U(0.004, 0.010))             # quick rejection wick at the top/bottom
            consolidation((6, 30))
            r = rng.random()
            if r < 0.35:                                   # retest of the broken level (impulse origin ± )
                drift(origin + d * U(-0.004, 0.004) - x, (16, 48))
                reversal(d * U(0.006, 0.014))
            elif r < 0.8:                                  # ordinary pullback 30–60 %
                drift(-size * U(0.3, 0.6), (24, 96))
            consolidation((8, 40))
    elif reg == "volatile":
        while pos < length:
            sgn = 1.0 if rng.random() < 0.5 else -1.0
            size = sgn * U(0.04, 0.10)
            legs.append((pos, f"vol_impulse {int(sgn)}"))
            impulse(size, U(0.0020, 0.0045))
            if rng.random() < 0.6:
                reversal(-size * U(0.3, 0.7))
            consolidation((4, 24), amp=0.006)
            if rng.random() < 0.3:
                drift(-size * U(0.2, 0.5), (12, 48))
    else:
        raise ValueError(reg)
    return path, vshape, nmul, legs


def _gen_fixture(spec: dict, btc_sub_returns: Optional[np.ndarray]) -> tuple[pd.DataFrame, dict, np.ndarray]:
    """Returns (15m DataFrame over 400 days, meta, own sub-step returns)."""
    rng = np.random.default_rng(spec["seed"])
    n_sub = BARS_15M * SUB
    segs = _regime_schedule(rng, spec["regime"])

    mu = np.zeros(BARS_15M); sigma = np.zeros(BARS_15M); kk = np.zeros(BARS_15M)
    jp = np.zeros(BARS_15M); js = np.zeros(BARS_15M); vmult = np.ones(BARS_15M); sp = np.zeros(BARS_15M)
    wave = np.zeros(BARS_15M)                 # leg target relative to the segment anchor (log)
    vshape = np.ones(BARS_15M)
    nmul = np.ones(BARS_15M)
    leg_log: list = []
    seg_of = np.zeros(BARS_15M, dtype=int)
    mu_scale = 0.5 if spec["regime"] == "market" else 1.0
    for si, (a, b, reg) in enumerate(segs):
        p = REGIME_PARAMS[reg]
        sigma[a:b] = p["sigma"]; kk[a:b] = p["kn"]; jp[a:b] = p["jp"]; js[a:b] = p["js"]
        vmult[a:b] = p["vmult"]; sp[a:b] = p["sp"]; seg_of[a:b] = si
        wave[a:b], vshape[a:b], nmul[a:b], _lg = _legs(rng, reg, b - a, mu_scale)
        leg_log += [(int(a + p0), name) for p0, name in _lg if a + p0 < b]
    beta = float(spec["beta"])
    sig_own = sigma * (1.0 - 0.5 * beta)
    # volatility clustering: AR(1) state per 15m bar → sigma multiplier in [0.4, 2.5]
    vst = np.zeros(BARS_15M)
    e_v = rng.normal(0.0, 1.0, BARS_15M)
    for b in range(1, BARS_15M):
        vst[b] = 0.985 * vst[b - 1] + math.sqrt(1 - 0.985 ** 2) * e_v[b]
    vol_clust = np.clip(np.exp(0.4 * vst), 0.4, 2.5)
    sig_eff = sig_own * vol_clust * nmul

    events: list = []        # the "obvious setups" are produced by the leg engine (see legs_last_1h_window)
    mu_extra = np.zeros(n_sub)
    vol_extra = np.ones(BARS_15M)
    barriers: list = []

    # ── sub-step path (sequential: OU tracking of the swing target + impulses + reflections) ──
    eps = rng.normal(0.0, 1.0, n_sub)
    jumps = rng.normal(0.0, 1.0, n_sub) * (rng.random(n_sub) < np.repeat(jp, SUB)) * np.repeat(js, SUB)
    x_own = np.zeros(n_sub + 1)
    x_btc = np.zeros(n_sub + 1)
    if btc_sub_returns is not None:
        x_btc[1:] = np.cumsum(btc_sub_returns)
    own_ret = np.zeros(n_sub)
    anchors = {}
    barrier_level = {}
    sqrt_sub = math.sqrt(SUB)
    imp_shift = 0.0      # impulse events shift the target (the OU must not pull them back)
    prev_target = 0.0
    for t in range(n_sub):
        b = t // SUB
        seg = seg_of[b]
        xo = x_own[t]
        if seg not in anchors:
            anchors[seg] = xo - imp_shift
            prev_target = xo
        imp_shift += mu_extra[t]
        target = anchors[seg] + wave[b] + imp_shift
        dev = xo - prev_target
        dev = dev * (1.0 - kk[b] / SUB) + sig_eff[b] / sqrt_sub * eps[t] + jumps[t]
        xn = target + dev
        prev_target = target
        x_tot = beta * x_btc[t + 1] + xn
        for bi, (s0, s1, kind, off) in enumerate(barriers):
            if s0 <= t < s1:
                if bi not in barrier_level:
                    base_tot = beta * x_btc[t] + xo
                    barrier_level[bi] = base_tot - off if kind == "support" else base_tot + off
                lvl = barrier_level[bi]
                if kind == "support" and x_tot < lvl:
                    xn += 1.6 * (lvl - x_tot)
                elif kind == "resistance" and x_tot > lvl:
                    xn -= 1.6 * (x_tot - lvl)
        x_own[t + 1] = xn
        own_ret[t] = xn - xo
    x_tot = beta * x_btc + x_own + math.log(spec["price"])
    px = np.exp(x_tot)                                    # n_sub + 1 points
    # ── 15m OHLC from sub-steps ──
    p_bars = px[1:].reshape(BARS_15M, SUB)
    opens = px[:-1:SUB].copy()
    closes = p_bars[:, -1]
    highs = np.maximum(p_bars.max(axis=1), opens)
    lows = np.minimum(p_bars.min(axis=1), opens)
    wick = np.abs(rng.normal(0.0, 0.35, (BARS_15M, 2))) * sig_eff[:, None]
    highs = highs * (1.0 + wick[:, 0])
    lows = lows * (1.0 - wick[:, 1])
    # ── volume (quote-currency, like fetcher's volCcyQuote) ──
    hours = ((np.arange(BARS_15M) // 4) % 24)
    season = 0.55 + 0.9 * np.exp(-((hours - 14.5) ** 2) / 18.0) + 0.25 * (hours >= 7) * (hours <= 20)
    bar_ret = np.diff(np.log(np.r_[opens[0], closes]))
    vol = spec["base_vol"] * vmult * vshape * season * np.exp(rng.normal(0.0, 0.40, BARS_15M)) * (0.7 + 0.6 * vol_clust)
    vol *= 1.0 + 1.5 * np.abs(bar_ret) / np.maximum(sig_eff, 1e-9)
    spikes = rng.random(BARS_15M) < sp
    vol *= np.where(spikes, rng.uniform(2.5, 7.0, BARS_15M), 1.0)
    vol *= vol_extra
    idx = pd.date_range(T_END - pd.Timedelta(days=N_DAYS), periods=BARS_15M, freq="15min")
    df15 = pd.DataFrame({"open": opens, "high": highs, "low": lows, "close": closes, "volume": vol}, index=idx)
    df15.index.name = "open_time"
    meta = dict(symbol=spec["symbol"], regime=spec["regime"], seed=spec["seed"], beta=beta,
                price_scale=spec["price"], base_vol=spec["base_vol"], memcoin=spec["memcoin"],
                segments=[(int(a), int(b), r) for a, b, r in segs], events=events,
                legs_last_1h_window=[(int((p0 - (BARS_15M - STORE_BARS["1h"] * 4)) // 4), name) for p0, name in leg_log
                                     if p0 >= BARS_15M - STORE_BARS["1h"] * 4])
    return df15, meta, own_ret


def _resample(df15: pd.DataFrame, tf: str) -> pd.DataFrame:
    if tf == "15m":
        return df15
    agg = df15.resample(TF_RULE[tf], label="left", closed="left").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}).dropna()
    agg.index.name = "open_time"
    return agg


def _f10(x: float) -> float:
    return float(f"{float(x):.10g}")


def fixture_json(symbol: str, tf: str, df: pd.DataFrame) -> dict:
    bars = []
    for ts, row in zip(df.index, df.to_numpy()):
        ms = int(pd.Timestamp(ts).value // 1_000_000)
        assert ms % TF_MS[tf] == 0, (symbol, tf, ts)
        bars.append([ms] + [_f10(v) for v in row])
    return {"symbol": symbol, "tf": tf, "bars": bars}


def generate_candles(specs: list[dict], out_dir: str) -> dict:
    os.makedirs(os.path.join(out_dir, "candles"), exist_ok=True)
    index = {"t_end_utc": str(T_END), "tf_ms": TF_MS, "bars_stored": STORE_BARS,
             "format": "{symbol, tf, bars: [[open_time_ms, open, high, low, close, volume], ...]}; "
                       "all series end at t_end (last bar closes exactly at t_end); open_time aligned to the TF; "
                       "1h/4h/1d are OHLCV resamples of the same 15m path, so the TFs are mutually consistent",
             "fixtures": []}
    btc_ret = None
    for spec in specs:
        df15, meta, own_ret = _gen_fixture(spec, btc_ret if spec["symbol"] != "BTC-USDT-SWAP" else None)
        if spec["symbol"] == "BTC-USDT-SWAP":
            btc_ret = own_ret
        files = {}
        for tf in ("15m", "1h", "4h", "1d"):
            d = _resample(df15, tf).tail(STORE_BARS[tf])
            fn = f"candles/{spec['symbol']}_{tf}.json"
            with open(os.path.join(out_dir, fn), "w") as fh:
                json.dump(fixture_json(spec["symbol"], tf, d), fh, separators=(",", ":"))
            files[tf] = fn
        meta["files"] = files
        meta["close_last"] = _f10(df15["close"].iloc[-1])
        index["fixtures"].append(meta)
        print(f"  candles {spec['symbol']:<22} regime={spec['regime']:<14} last_close={meta['close_last']:.6g}", flush=True)
    with open(os.path.join(out_dir, "candles", "index.json"), "w") as fh:
        json.dump(index, fh, indent=1)
    return index


# ────────────────────────────────────────────────────────────────────────────
# Loading fixtures back (the strategies run on the JSON data, never on in-memory arrays)
# ────────────────────────────────────────────────────────────────────────────
def load_df(out_dir: str, symbol: str, tf: str) -> pd.DataFrame:
    with open(os.path.join(out_dir, "candles", f"{symbol}_{tf}.json")) as fh:
        fx = json.load(fh)
    arr = np.array(fx["bars"], dtype=float)
    idx = pd.to_datetime(arr[:, 0].astype("int64"), unit="ms")   # naive UTC, like fetcher.py
    df = pd.DataFrame({"open": arr[:, 1], "high": arr[:, 2], "low": arr[:, 3],
                       "close": arr[:, 4], "volume": arr[:, 5]}, index=idx)
    df.index.name = "open_time"
    return df


def open_ms(df: pd.DataFrame) -> np.ndarray:
    return (df.index.asi8 // 1_000_000)


def aligned_prefix(df: pd.DataFrame, tf: str, close_ms: int, window: Optional[int]) -> Optional[pd.DataFrame]:
    """All bars of `df` that are CLOSED at close_ms (open + tf <= close_ms), optionally the last `window`."""
    n = int(np.searchsorted(open_ms(df) + TF_MS[tf], close_ms, side="right"))
    sub = df.iloc[:n]
    if window:
        sub = sub.iloc[-window:]
    return sub if len(sub) else None


# ────────────────────────────────────────────────────────────────────────────
# JSON helpers
# ────────────────────────────────────────────────────────────────────────────
def r10(x):
    """Round floats to 10 significant digits, recursively. NaN/inf → None."""
    if isinstance(x, (bool, np.bool_)):
        return bool(x)
    if isinstance(x, (int, np.integer)):
        return int(x)
    if isinstance(x, (float, np.floating)):
        x = float(x)
        if math.isnan(x) or math.isinf(x):
            return None
        return float(f"{x:.10g}")
    if isinstance(x, dict):
        return {str(k): r10(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [r10(v) for v in x]
    if isinstance(x, (pd.Timestamp, np.datetime64)):
        return str(x)
    if x is None or isinstance(x, str):
        return x
    return str(x)


class LogCapture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.records: list[str] = []

    def emit(self, record):
        self.records.append(f"{record.name}: {record.getMessage()}")


# ────────────────────────────────────────────────────────────────────────────
# Variants
# ────────────────────────────────────────────────────────────────────────────
# LEVELS: IndConfig is built from TradeCfg exactly like scanner_mid._cfg_to_ind(); profiles.py only
# changes the scanner-side min_quality (7 conservative / 5 active; TradeCfg default 3), so the
# TradeCfg tweaks below are ours, chosen to exercise use_htf (1D zone confluence) and HIGH_WR_MODE.
LEVELS_VARIANTS = {
    "default":      dict(trade_cfg={}, high_wr_mode=False, min_quality=3, profile=None),
    "conservative": dict(trade_cfg=dict(use_htf=True, vol_mult=1.2, rsi_ob=60, rsi_os=40, min_quality=7),
                         high_wr_mode=True, min_quality=7, profile="conservative"),
    "active":       dict(trade_cfg=dict(use_htf=True, vol_mult=0.8, zone_pct=1.0, max_dist_pct=2.0, min_rr=1.5,
                                        cooldown_bars=3, min_quality=5),
                         high_wr_mode=False, min_quality=5, profile="active"),
}
# SMC: SMCUserCfg → (SMCConfig for the analyzer + builder kwargs) exactly like smc/scanner._scan_cycle.
SMC_VARIANTS = {
    "default":      dict(user_cfg={}, high_wr_mode=False),
    "conservative": dict(user_cfg=dict(min_confirmations=4, min_rr=2.5, smc_pd_filter=True, smc_mtf_check=True,
                                       smc_retrace_depth=0.5, smc_use_volume_filter=True, smc_conf_type="BODY_CLOSE"),
                         high_wr_mode=True),
    "active":       dict(user_cfg=dict(min_confirmations=2, min_rr=1.5, smc_conf_type="WICK_TOUCH", smc_pd_filter=False,
                                       smc_retrace_depth=0.0, smc_mtf_check=False, sweep_close_req=False,
                                       ob_max_age=50, smc_vol_mult=1.0),
                         high_wr_mode=False),
}
# VOLUME: VolumeConfig.from_params(dict) exactly like volume_scanner.load_user_cfg; profiles.py sets
# min_quality 4 (conservative) / 3 (active; = default).
VOLUME_VARIANTS = {
    "default":      dict(params={}),
    "conservative": dict(params=dict(min_quality=4, vol_mult=2.0, trend_filter=True, use_htf=True, bounce_vol_mult=1.2)),
    "active":       dict(params=dict(min_quality=2, ma_type="ema", ma_fast=9, ma_mid=21, trend_filter=False, use_htf=False,
                                     vol_mult=1.2, setup_ribbon=True)),
}

SWEEP_TF = "1h"
WARMUP = 200                 # first swept index on the 1h series (len(df) = 201); analyze() needs >= 200 bars
LEVELS_HTF_WINDOW = 300      # 1D bars fed when use_htf (WS cache / REST limit=300)
SMC_HTF_WINDOW = 300         # 4H bars
SMC_LTF_WINDOW = 300         # 15m bars
VOLUME_HTF_WINDOW = 300      # 4h bars


def _smc_cfg_from_user(ucfg, high_wr_mode: bool):
    """Replicates smc/scanner._scan_cycle user-cache construction (momentum relaxed mode = off)."""
    from smc.analyzer import SMCConfig
    from smc.scanner import _analysis_key
    cfg_obj = SMCConfig()
    cfg_obj.MIN_CONFIRMATIONS = ucfg.min_confirmations
    cfg_obj.MIN_RR = ucfg.min_rr
    cfg_obj.SL_BUFFER_PCT = ucfg.sl_buffer_pct
    cfg_obj.FVG_ENABLED = ucfg.fvg_enabled
    cfg_obj.CHOCH_ENABLED = ucfg.choch_enabled
    cfg_obj.OB_USE_BREAKER = ucfg.ob_use_breaker
    cfg_obj.OB_MAX_AGE_CANDLES = ucfg.ob_max_age
    cfg_obj.SWEEP_CLOSE_REQUIRED = ucfg.sweep_close_req
    cfg_obj.VOL_MULT = float(getattr(ucfg, "smc_vol_mult", 1.2) or 1.2)
    cfg_obj.VOL_LEN = int(getattr(ucfg, "smc_vol_len", 20) or 20)
    cfg_obj.USE_VOLUME_FILTER = bool(getattr(ucfg, "smc_use_volume_filter", False))
    an_key = _analysis_key(cfg_obj)
    if high_wr_mode:
        cfg_obj.MIN_CONFIRMATIONS = max(cfg_obj.MIN_CONFIRMATIONS, 4)
        pd_filter, mtf_check = True, True
    else:
        pd_filter = getattr(ucfg, "smc_pd_filter", False)
        mtf_check = getattr(ucfg, "smc_mtf_check", False)
    builder_kwargs = dict(tf_htf="4H", tf_mtf="1H", tf_ltf="15m", allowed_dirs=("LONG", "SHORT"),
                          conf_type=getattr(ucfg, "smc_conf_type", "WICK_TOUCH"), pd_filter=pd_filter,
                          retrace_depth=getattr(ucfg, "smc_retrace_depth", 0.0), mtf_check=mtf_check)
    return cfg_obj, an_key, builder_kwargs


def _smc_cfg_dict(cfg_obj) -> dict:
    return {k: getattr(cfg_obj, k) for k in dir(cfg_obj) if k.isupper() and not k.startswith("_")}


def build_variant_configs() -> dict:
    from scanner_mid import _cfg_to_ind
    from user_manager import TradeCfg, SMCUserCfg
    from volume_strategy import VolumeConfig
    import dataclasses as dc
    out = {"levels": {}, "smc": {}, "volume": {}}
    for name, v in LEVELS_VARIANTS.items():
        tc = TradeCfg(**v["trade_cfg"])
        ic = _cfg_to_ind(tc, high_wr_mode=v["high_wr_mode"])
        out["levels"][name] = dict(trade_cfg=dc.asdict(tc), ind_config=dc.asdict(ic), high_wr_mode=v["high_wr_mode"],
                                   scanner_post_filter=dict(min_quality=v["min_quality"], profile=v["profile"]),
                                   inputs=dict(df=f"{SWEEP_TF} prefix [:i+1]",
                                               df_htf=(f"1d aligned prefix, last {LEVELS_HTF_WINDOW}" if ic.USE_HTF_FILTER else "None (use_htf=False)"),
                                               df_btc=f"BTC-USDT-SWAP {SWEEP_TF} prefix [:i+1]", df_eth=f"ETH-USDT-SWAP {SWEEP_TF} prefix [:i+1]"))
    for name, v in SMC_VARIANTS.items():
        uc = SMCUserCfg(**v["user_cfg"])
        cfg_obj, an_key, bk = _smc_cfg_from_user(uc, v["high_wr_mode"])
        out["smc"][name] = dict(smc_user_cfg=dc.asdict(uc), high_wr_mode=v["high_wr_mode"], smc_config=_smc_cfg_dict(cfg_obj),
                                analysis_key=list(an_key), build_kwargs=dict(bk, allowed_dirs=list(bk["allowed_dirs"])),
                                inputs=dict(df_htf=f"4h aligned prefix, last {SMC_HTF_WINDOW}", df_mtf=f"{SWEEP_TF} prefix [:i+1]",
                                            df_ltf=f"15m aligned prefix, last {SMC_LTF_WINDOW}",
                                            squeeze_score="squeeze_detector.compute_squeeze_score(df_mtf) injected into analysis before build"))
    for name, v in VOLUME_VARIANTS.items():
        vc = VolumeConfig.from_params(v["params"])
        pre = dc.replace(vc, use_htf=False, min_quality=max(1, vc.min_quality - 1))
        out["volume"][name] = dict(params=v["params"], volume_config=vc.to_dict(), scanner_prepass_config=pre.to_dict(),
                                   inputs=dict(df=f"{SWEEP_TF} prefix [:i+1]", timeframe=SWEEP_TF,
                                               df_htf=(f"4h aligned prefix, last {VOLUME_HTF_WINDOW}" if vc.use_htf else "None (use_htf=False)")))
    return out


# ────────────────────────────────────────────────────────────────────────────
# Per-fixture runners
# ────────────────────────────────────────────────────────────────────────────
_CAP = LogCapture()


def _attach_capture():
    for name in ("CHM.Indicator", "CHM.VolumeStrategy", "CHM.SMC.Analyzer", "CHM.SMC.SignalBuilder",
                 "CHM.SMC.Structure", "CHM.SMC.Liquidity", "CHM.SMC.OrderBlock", "CHM.SMC.FVG",
                 "CHM.SMC.PremiumDiscount", "CHM.LevelsFilters", "CHM.MarketRegime", "CHM.LiquiditySL"):
        lg = logging.getLogger(name)
        if _CAP not in lg.handlers:
            lg.addHandler(_CAP)
        lg.setLevel(logging.WARNING)


def _sweep_indices(n: int, step: int) -> list[int]:
    idx = list(range(WARMUP, n, step))
    if idx and idx[-1] != n - 1:
        idx.append(n - 1)
    return idx


def run_levels(symbol: str, frames: dict, step: int) -> dict:
    import indicator
    from indicator import CHMIndicator, reset_analyze_stats, get_analyze_stats
    from scanner_mid import _cfg_to_ind
    from user_manager import TradeCfg
    from squeeze_detector import compute_squeeze_score
    import momentum_detector as md
    assert not md.is_relaxed_mode()
    df1h, df1d = frames["1h"], frames["1d"]
    btc1h, eth1h = frames["btc_1h"], frames["eth_1h"]
    oms = open_ms(df1h)
    n = len(df1h)
    out = {}
    for vname, v in LEVELS_VARIANTS.items():
        ic = _cfg_to_ind(TradeCfg(**v["trade_cfg"]), high_wr_mode=v["high_wr_mode"])
        signals, rejects, errors, warns = [], {}, [], {}
        for i in _sweep_indices(n, step):
            df = df1h.iloc[:i + 1]
            close_ms = int(oms[i]) + TF_MS["1h"]
            df_htf = aligned_prefix(df1d, "1d", close_ms, LEVELS_HTF_WINDOW) if ic.USE_HTF_FILTER else None
            btc = btc1h.iloc[:i + 1]
            eth = eth1h.iloc[:i + 1]
            ind = CHMIndicator(ic)          # fresh instance: empty zone cache, no cooldown state
            reset_analyze_stats()
            _CAP.records.clear()
            try:
                sig = ind.analyze(symbol, df, df_htf, btc, eth)
            except Exception as e:          # noqa: BLE001
                errors.append(dict(i=i, ts=str(df.index[-1]), error=f"{type(e).__name__}: {e}"))
                continue
            if _CAP.records:
                warns[str(i)] = list(_CAP.records)
            if sig is None:
                st = get_analyze_stats()
                rejects[str(i)] = ",".join(sorted(st)) if st else "none"
                continue
            d = dataclasses.asdict(sig)
            sq = int(compute_squeeze_score(df) or 0)
            q_after = min(d["quality"] + 1, 10) if sq >= 1 else d["quality"]
            d.update(i=i, ts=str(df.index[-1]), open_time_ms=int(oms[i]), n_bars=len(df),
                     n_htf_bars=(len(df_htf) if df_htf is not None else 0),
                     squeeze_score=sq, quality_after_squeeze=q_after,
                     passes_min_quality=bool(q_after >= v["min_quality"]))
            signals.append(r10(d))
        out[vname] = dict(swept=[WARMUP, n - 1], step=step, n_swept=len(_sweep_indices(n, step)),
                          n_signals=len(signals), signal_bars=[s["i"] for s in signals],
                          signals=signals, reject_reasons=rejects, errors=errors, warnings=warns)
    return out


_SMC_DIGEST_KEYS = ("trend", "bos", "choch", "sweep_up", "sweep_down", "bull_ob", "bear_ob", "bull_fvg", "bear_fvg",
                    "pd_zone", "atr", "vol_ratio", "current_price", "squeeze_score")


def _smc_digest(a: dict) -> dict:
    s, liq, ob, fvg = a.get("structure", {}), a.get("liquidity", {}), a.get("ob", {}), a.get("fvg", {})

    def _ob(o):
        if not o:
            return None
        return {k: o.get(k) for k in ("found", "ob_low", "ob_high", "ob_mid", "ob_50_reached", "type", "mitigated", "bar_ago", "is_breaker")} | \
               {"impulse_fvg": (None if not o.get("impulse_fvg") else {k: o["impulse_fvg"].get(k) for k in ("fvg_low", "fvg_high", "idx")})}

    def _fvg(f):
        return None if not f else {k: f.get(k) for k in ("type", "fvg_low", "fvg_high", "idx", "inversed")}

    def _sw(x):
        return None if not x else {k: x.get(k) for k in ("swept", "level", "wick_ratio")}

    return r10(dict(
        trend=s.get("trend"), bos=s.get("bos"), choch=s.get("choch"),
        n_swing_highs=len(s.get("swing_highs", [])), n_swing_lows=len(s.get("swing_lows", [])),
        last_swing_high=(s.get("last_swing_high") or {}).get("price"), last_swing_low=(s.get("last_swing_low") or {}).get("price"),
        equal_highs=[e["price"] for e in liq.get("equal_highs", [])], equal_lows=[e["price"] for e in liq.get("equal_lows", [])],
        sweep_up=_sw(liq.get("sweep_up")), sweep_down=_sw(liq.get("sweep_down")),
        bull_ob=_ob(ob.get("bull_ob")), bear_ob=_ob(ob.get("bear_ob")),
        n_fvgs=len(fvg.get("all_fvgs", [])), n_ifvgs=len(fvg.get("ifvgs", [])),
        bull_fvg=_fvg(fvg.get("bull_fvg")), bear_fvg=_fvg(fvg.get("bear_fvg")),
        pd_zone=a.get("pd_zone"), atr=a.get("atr"), vol_ratio=a.get("vol_ratio"), vol_avg=a.get("vol_avg"),
        current_price=a.get("current_price"), current_high=a.get("current_high"), current_low=a.get("current_low"),
        squeeze_score=a.get("squeeze_score"), error=a.get("error"),
    ))


def run_smc(symbol: str, frames: dict, step: int) -> tuple[dict, dict]:
    from smc.analyzer import SMCAnalyzer, SMCConfig
    from smc.signal_builder import build_smc_signal
    from user_manager import SMCUserCfg
    from squeeze_detector import compute_squeeze_score
    df1h, df4h, df15 = frames["1h"], frames["4h"], frames["15m"]
    oms = open_ms(df1h)
    n = len(df1h)
    out, digest = {}, {}
    analyzers: dict[tuple, SMCAnalyzer] = {}
    analyses_cache: dict[tuple, dict] = {}
    for vname, v in SMC_VARIANTS.items():
        ucfg = SMCUserCfg(**v["user_cfg"])
        cfg_obj, an_key, bk = _smc_cfg_from_user(ucfg, v["high_wr_mode"])
        if an_key not in analyzers:   # smc/scanner._analyzer_for
            analyzers[an_key] = SMCAnalyzer(SMCConfig(FVG_ENABLED=an_key[0], CHOCH_ENABLED=an_key[1], OB_USE_BREAKER=an_key[2],
                                                      OB_MAX_AGE_CANDLES=an_key[3], SWEEP_CLOSE_REQUIRED=an_key[4], VOL_LEN=an_key[5]))
        an = analyzers[an_key]
        signals, rejects, errors, warns = [], {}, [], {}
        for i in _sweep_indices(n, step):
            df_mtf = df1h.iloc[:i + 1]
            close_ms = int(oms[i]) + TF_MS["1h"]
            df_htf = aligned_prefix(df4h, "4h", close_ms, SMC_HTF_WINDOW)
            df_ltf = aligned_prefix(df15, "15m", close_ms, SMC_LTF_WINDOW)
            _CAP.records.clear()
            ck = (an_key, i)
            try:
                if ck in analyses_cache:
                    analysis = analyses_cache[ck]
                else:
                    analysis = an.analyze(symbol, df_htf, df_mtf, df_ltf)
                    analysis["squeeze_score"] = int(compute_squeeze_score(df_mtf) or 0)
                    analyses_cache[ck] = analysis
                if vname == "default":
                    digest[str(i)] = _smc_digest(analysis)
                if analysis.get("error"):
                    errors.append(dict(i=i, ts=str(df_mtf.index[-1]), error=f"analysis.error: {analysis['error']}"))
                sig = build_smc_signal(symbol, analysis, cfg_obj, **bk)
            except Exception as e:          # noqa: BLE001
                errors.append(dict(i=i, ts=str(df_mtf.index[-1]), error=f"{type(e).__name__}: {e}"))
                continue
            if _CAP.records:
                warns[str(i)] = list(_CAP.records)
            if sig is None:
                continue
            d = dataclasses.asdict(sig)
            d["confirmations"] = [[lbl, bool(ok)] for lbl, ok in d["confirmations"]]
            d.update(i=i, ts=str(df_mtf.index[-1]), open_time_ms=int(oms[i]), n_mtf_bars=len(df_mtf),
                     n_htf_bars=(len(df_htf) if df_htf is not None else 0), n_ltf_bars=(len(df_ltf) if df_ltf is not None else 0),
                     squeeze_score=analysis.get("squeeze_score", 0),
                     passes_ctx_gate=bool(int(sig.score) >= int(cfg_obj.MIN_CONFIRMATIONS)),
                     rr_ladder=[round(abs(float(getattr(sig, k)) - sig.entry) / abs(sig.entry - sig.sl), 2) for k in ("tp1", "tp2", "tp3")]
                     if abs(sig.entry - sig.sl) > 0 else [0.0, 0.0, 0.0])
            signals.append(r10(d))
        out[vname] = dict(swept=[WARMUP, n - 1], step=step, n_swept=len(_sweep_indices(n, step)),
                          n_signals=len(signals), signal_bars=[s["i"] for s in signals],
                          signals=signals, errors=errors, warnings=warns)
    return out, digest


def run_volume(symbol: str, frames: dict, step: int) -> dict:
    import dataclasses as dc
    from volume_strategy import VolumeConfig, analyze_volume, htf_for
    from squeeze_detector import compute_squeeze_score
    df1h, df4h = frames["1h"], frames["4h"]
    oms = open_ms(df1h)
    n = len(df1h)
    out = {}
    for vname, v in VOLUME_VARIANTS.items():
        cfg = VolumeConfig.from_params(v["params"])
        pre_cfg = dc.replace(cfg, use_htf=False, min_quality=max(1, cfg.min_quality - 1))
        signals, errors, warns, prepass_mismatch = [], [], {}, []
        for i in _sweep_indices(n, step):
            df = df1h.iloc[:i + 1]
            close_ms = int(oms[i]) + TF_MS["1h"]
            df_htf = aligned_prefix(df4h, "4h", close_ms, VOLUME_HTF_WINDOW) if cfg.use_htf else None
            _CAP.records.clear()
            try:
                sig = analyze_volume(symbol, df, cfg, SWEEP_TF, df_htf)
                if cfg.use_htf and htf_for(SWEEP_TF):   # volume_scanner._analyze_with_htf pre-pass
                    pre = analyze_volume(symbol, df, pre_cfg, SWEEP_TF)
                    if (pre is None) != (sig is None):
                        prepass_mismatch.append(i)
            except Exception as e:          # noqa: BLE001
                errors.append(dict(i=i, ts=str(df.index[-1]), error=f"{type(e).__name__}: {e}"))
                continue
            if _CAP.records:   # analyze_volume swallows exceptions and logs [VOLUME-ERR]
                warns[str(i)] = list(_CAP.records)
                if any("[VOLUME-ERR]" in r for r in _CAP.records):
                    errors.append(dict(i=i, ts=str(df.index[-1]), error="; ".join(_CAP.records)))
            if sig is None:
                continue
            d = dc.asdict(sig)
            sq = 0
            if sig.setup not in ("bounce", "ribbon"):
                sq = int(compute_squeeze_score(df) or 0)
            q_after = min(5, d["quality"] + 1) if sq >= 1 else d["quality"]
            d.update(i=i, ts=str(df.index[-1]), open_time_ms=int(oms[i]), n_bars=len(df),
                     n_htf_bars=(len(df_htf) if df_htf is not None else 0),
                     tp=sig.tp, risk_pct=sig.risk_pct, volume_ratio=sig.volume_ratio,
                     squeeze_score=sq, quality_after_squeeze=q_after,
                     passes_ctx_gate=bool(q_after >= cfg.min_quality))
            signals.append(r10(d))
        out[vname] = dict(swept=[WARMUP, n - 1], step=step, n_swept=len(_sweep_indices(n, step)),
                          n_signals=len(signals), signal_bars=[s["i"] for s in signals],
                          signals=signals, errors=errors, warnings=warns, scanner_prepass_mismatch_bars=prepass_mismatch)
    return out


def run_fixture(args) -> dict:
    symbol, out_dir, step, only = (args + (("levels", "smc", "volume"),))[:4]
    _attach_capture()
    t0 = time.time()
    frames = {tf: load_df(out_dir, symbol, tf) for tf in ("15m", "1h", "4h", "1d")}
    frames["btc_1h"] = load_df(out_dir, "BTC-USDT-SWAP", "1h")
    frames["eth_1h"] = load_df(out_dir, "ETH-USDT-SWAP", "1h")
    res = {"symbol": symbol}
    empty = {v: dict(swept=[WARMUP, len(frames["1h"]) - 1], step=step, n_swept=0, n_signals=0, signal_bars=[], signals=[],
                     errors=[], warnings={}, reject_reasons={}, scanner_prepass_mismatch_bars=[]) for v in ("default", "conservative", "active")}
    res["levels"] = run_levels(symbol, frames, step) if "levels" in only else empty
    res["smc"], res["smc_digest"] = run_smc(symbol, frames, step) if "smc" in only else (empty, {})
    res["volume"] = run_volume(symbol, frames, step) if "volume" in only else empty
    res["seconds"] = round(time.time() - t0, 1)
    counts = {s: {v: res[s][v]["n_signals"] for v in res[s]} for s in ("levels", "smc", "volume")}
    print(f"  done {symbol:<22} {res['seconds']:>6.1f}s  {counts}", flush=True)
    return res


# ────────────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────────────
def _sha(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ────────────────────────────────────────────────────────────────────────────
# Layer dumps (PLAN §3 — localise a divergence to a layer instead of a final signal)
#   --dump-zones       LEVELS indicator._get_zones() per swept bar (default variant IndConfig):
#                      pivots, KDE peaks, HVN/LVN, atr_now, sup/res zone dicts without `lvn_checker`
#   --dump-volume-ctx  VOLUME VolumeContext columns at the last bar (default VolumeConfig, HTF 4h)
#   --dump-squeeze     squeeze_detector internals: bbw[-1], thr_strong, thr_some, atr_ratio, score
# Written to <out_dir>/dumps/{zones,volume_ctx,squeeze}.json; all additive, bar-level, pure.
# ────────────────────────────────────────────────────────────────────────────
def _zone_public(z: dict) -> dict:
    return {k: v for k, v in z.items() if k != "lvn_checker"}


def dump_zones(symbol: str, frames: dict, variants: dict, step: int) -> dict:
    from indicator import CHMIndicator
    from scanner_mid import _cfg_to_ind
    from user_manager import TradeCfg
    v = variants["levels"]["default"]
    ic = _cfg_to_ind(TradeCfg(**v["trade_cfg"]), high_wr_mode=v["high_wr_mode"])
    df1h = frames["1h"]
    out = {}
    for i in _sweep_indices(len(df1h), step):
        df = df1h.iloc[:i + 1]
        ind = CHMIndicator(ic)
        atr = ind._atr(df, ic.ATR_PERIOD)
        atr_now = float(atr.iloc[-1]) if len(atr) >= 2 else float(df["close"].mean() * 0.01)
        highs, lows, n = df["high"].values, df["low"].values, len(df)
        s = ic.PIVOT_STRENGTH
        res_pts = [(float(highs[k]), n - 1 - k) for k in range(s, n - s) if highs[k] == max(highs[k - s:k + s + 1])]
        sup_pts = [(float(lows[k]), n - 1 - k) for k in range(s, n - s) if lows[k] == min(lows[k - s:k + s + 1])]
        price_range = (float(df["low"].min()), float(df["high"].max()))
        kde_prices = ind._kde_levels([p for p, _ in res_pts + sup_pts], price_range)
        vp = ind._volume_profile(df)
        sup, res = ind._get_zones(df, ic.PIVOT_STRENGTH, atr_now)
        out[str(i)] = r10(dict(atr_now=atr_now, price_range=list(price_range), n_pivots=len(res_pts) + len(sup_pts),
                               pivots_res=res_pts, pivots_sup=sup_pts, kde_peaks=kde_prices,
                               hvn=vp["hvn"], lvn=vp["lvn"], vp_volumes=list(vp["volumes"]),
                               sup=[_zone_public(z) for z in sup], res=[_zone_public(z) for z in res]))
    return out


def dump_volume_ctx(symbol: str, frames: dict, variants: dict, step: int) -> dict:
    import volume_strategy as vs
    cfg = vs.VolumeConfig.from_params(variants["volume"]["default"]["params"])
    df1h, df4h = frames["1h"], frames["4h"]
    oms = open_ms(df1h)
    out = {}
    for i in _sweep_indices(len(df1h), step):
        df = df1h.iloc[:i + 1]
        close_ms = int(oms[i]) + TF_MS["1h"]
        df_htf = aligned_prefix(df4h, "4h", close_ms, VOLUME_HTF_WINDOW) if cfg.use_htf else None
        st = int(vs.htf_state(df_htf, cfg)) if (cfg.use_htf and df_htf is not None) else 0
        htf_arr = None
        if st != 0:
            htf_arr = np.zeros(len(df), dtype=np.int8)
            htf_arr[-1] = st
        ctx = vs.VolumeContext(df, cfg, htf_arr, vs.htf_for(SWEEP_TF) if st != 0 else "")
        last = -1
        rec = dict(n=ctx.n, min_bars=int(vs.min_bars(cfg)), e50=float(ctx.e50[last]), e200=float(ctx.e200[last]),
                   maF=float(ctx.maF[last]), maM=float(ctx.maM[last]), maS=float(ctx.maS[last]), turn=float(ctx.turn[last]),
                   rsi=float(ctx.rsi[last]), atr=float(ctx.atr[last]), tr=float(ctx.tr[last]),
                   vavg=float(ctx.vavg[last]), vr=float(ctx.vr[last]),
                   rib=[float(x) for x in ctx.rib[:, last]] if ctx.rib is not None else None,
                   htf_state=st, htf_tf=ctx.htf_tf, n_htf_bars=(len(df_htf) if df_htf is not None else 0),
                   candidate=bool(ctx.candidate_mask()[last]))
        out[str(i)] = r10(rec)
    return out


def dump_squeeze(symbol: str, frames: dict, step: int) -> dict:
    import squeeze_detector as sq
    df1h = frames["1h"]
    out = {}
    n_look = 50
    for i in _sweep_indices(len(df1h), step):
        df = df1h.iloc[:i + 1]
        rec = dict(n=len(df), score=int(sq.compute_squeeze_score(df) or 0), bbw_last=None, thr_strong=None, thr_some=None,
                   atr14=None, atr50=None, atr_ratio=None)
        if len(df) >= max(n_look + 21, 51):
            bbw = sq._bb_width(df).dropna()
            if len(bbw) >= n_look:
                recent = bbw.iloc[-n_look:]
                rec["bbw_last"] = float(bbw.iloc[-1])
                rec["thr_strong"] = float(recent.quantile(0.15))
                rec["thr_some"] = float(recent.quantile(0.30))
                rec["bbw_recent"] = [float(x) for x in recent]
            atr14 = sq._atr(df, 14).dropna()
            atr50 = sq._atr(df, 50).dropna()
            if len(atr14) and len(atr50):
                rec["atr14"] = float(atr14.iloc[-1]); rec["atr50"] = float(atr50.iloc[-1])
                rec["atr_ratio"] = float(atr14.iloc[-1]) / max(float(atr50.iloc[-1]), 1e-9)
        out[str(i)] = r10(rec)
    return out


def run_dumps(symbols: list[str], out_dir: str, args, variants: dict) -> None:
    os.makedirs(os.path.join(out_dir, "dumps"), exist_ok=True)
    common = dict(python=sys.version.split()[0], pandas=pd.__version__, numpy=np.__version__,
                  sweep=dict(tf=SWEEP_TF, warmup_index=WARMUP, step=args.dump_step), symbols=symbols)
    todo = []
    if args.dump_zones:
        todo.append(("zones", "LEVELS indicator._get_zones() layers per swept bar (default variant IndConfig); "
                              "zone dicts without lvn_checker; pivots as [price, age_bars]", dump_zones))
    if args.dump_volume_ctx:
        todo.append(("volume_ctx", "VOLUME VolumeContext columns at the last bar (default VolumeConfig, HTF 4h aligned prefix)",
                     dump_volume_ctx))
    if args.dump_squeeze:
        todo.append(("squeeze", "squeeze_detector.compute_squeeze_score internals per swept bar", dump_squeeze))
    for name, note, fn in todo:
        t0 = time.time()
        fixtures = {}
        for sym in symbols:
            frames = {tf: load_df(out_dir, sym, tf) for tf in ("1h", "4h")}
            fixtures[sym] = fn(sym, frames, variants, args.dump_step) if fn is not dump_squeeze else fn(sym, frames, args.dump_step)
        path = os.path.join(out_dir, "dumps", f"{name}.json")
        doc = dict(dump=name, note=note, **common)
        if name == "zones":
            doc["ind_config"] = variants["levels"]["default"]["ind_config"]
        if name == "volume_ctx":
            doc["volume_config"] = variants["volume"]["default"]["volume_config"]
        doc["fixtures"] = fixtures
        with open(path, "w") as fh:
            json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
        print(f"  dump {name:<11} {len(symbols)} fixtures → {os.path.relpath(path, out_dir)} ({time.time() - t0:.1f}s)", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump-zones", action="store_true", help="write dumps/zones.json (LEVELS zone layers) and exit")
    ap.add_argument("--dump-volume-ctx", action="store_true", help="write dumps/volume_ctx.json (VOLUME context columns) and exit")
    ap.add_argument("--dump-squeeze", action="store_true", help="write dumps/squeeze.json (squeeze detector internals) and exit")
    ap.add_argument("--dump-step", type=int, default=1, help="sweep step for the dumps (default every bar)")
    ap.add_argument("--fixtures", type=int, default=None, help="only the first N fixtures (debug)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--step", type=int, default=1, help="sweep every k-th bar (1 = every bar)")
    ap.add_argument("--skip-candles", action="store_true", help="reuse candles/ already generated")
    ap.add_argument("--check", action="store_true", help="re-run 3 fixtures afterwards and verify identical output")
    ap.add_argument("--symbols", default=None, help="debug: comma-separated symbol prefixes to run (candles are still generated for all)")
    ap.add_argument("--only", default="levels,smc,volume", help="debug: strategies to run")
    ap.add_argument("--keep-others", action="store_true",
                    help="with --only: rewrite only the expected files of those strategies and merge their entries into the "
                         "existing summary.json (the other expected files are kept byte for byte)")
    args = ap.parse_args()
    out_dir = OUT_DIR
    os.makedirs(os.path.join(out_dir, "expected"), exist_ok=True)
    logging.basicConfig(level=logging.ERROR)
    t_all = time.time()

    specs = _fixture_specs(args.fixtures)
    if not args.skip_candles:
        print("generating candles ...", flush=True)
        generate_candles(specs, out_dir)
    with open(os.path.join(out_dir, "candles", "index.json")) as fh:
        index = json.load(fh)

    print("importing bot modules ...", flush=True)
    t0 = time.time()
    import indicator  # noqa: F401
    import scanner_mid  # noqa: F401
    import smc.scanner  # noqa: F401
    import volume_strategy  # noqa: F401
    import scipy
    print(f"  imports {time.time() - t0:.1f}s", flush=True)
    variants = build_variant_configs()
    from config import Config
    env_record = {k: os.environ.get(k) for k in _PINNED_ENV}
    env_record["Config.LEVELS_MIN_RR"] = Config.LEVELS_MIN_RR
    env_record["Config.LEVELS_REGIME_GATE"] = Config.LEVELS_REGIME_GATE

    symbols = [s["symbol"] for s in specs]
    if args.symbols:
        pref = tuple(x.strip() for x in args.symbols.split(",") if x.strip())
        symbols = [s for s in symbols if s.startswith(pref)]
    only = tuple(x.strip() for x in args.only.split(","))
    if args.dump_zones or args.dump_volume_ctx or args.dump_squeeze:
        _attach_capture()
        run_dumps(symbols, out_dir, args, variants)
        print(f"dumps done in {time.time() - t_all:.1f}s", flush=True)
        return 0
    jobs = [(s, out_dir, args.step, only) for s in symbols]
    print(f"running {len(symbols)} fixtures × 3 strategies × 3 variants (step={args.step}, workers={args.workers}) ...", flush=True)
    import multiprocessing as mp
    if args.workers > 1:
        with mp.get_context("fork").Pool(args.workers) as pool:
            results = list(pool.imap(run_fixture, jobs))
    else:
        results = [run_fixture(j) for j in jobs]
    results = {r["symbol"]: r for r in results}

    common = dict(generated_at_note="deterministic — no wall-clock values are used anywhere in the outputs",
                  python=sys.version.split()[0], pandas=pd.__version__, numpy=np.__version__, scipy=scipy.__version__,
                  bot_dir=BOT_DIR, env=env_record, sweep=dict(tf=SWEEP_TF, warmup_index=WARMUP, step=args.step,
                                                               rule="for each swept index i the strategy sees df.iloc[:i+1] of the 1h series; "
                                                                    "HTF/LTF frames = bars of that series closed at (open_time[i] + 1h), last W bars"),
                  float_rounding="10 significant digits (float(f'{x:.10g}')); NaN/inf → null")
    files = {}
    keep = bool(args.keep_others)
    for strat in ("levels", "smc", "volume"):
        if keep and strat not in only:
            continue
        doc = dict(strategy=strat, **common, variants=variants[strat],
                   fixtures={sym: results[sym][strat] for sym in symbols})
        if strat == "levels":
            doc["call"] = ("ind = indicator.CHMIndicator(scanner_mid._cfg_to_ind(TradeCfg(**trade_cfg), high_wr_mode)); "
                           "sig = ind.analyze(symbol, df, df_htf, df_btc, df_eth)  # fresh instance per bar")
            doc["signal_fields"] = "dataclasses.asdict(indicator.SignalResult) + i, ts, open_time_ms, n_bars, n_htf_bars, squeeze_score, quality_after_squeeze, passes_min_quality"
            doc["reject_reasons_note"] = "indicator._ANALYZE_STATS key incremented by _none_stat() for bars where analyze() returned None"
        elif strat == "smc":
            doc["call"] = ("an = SMCAnalyzer(SMCConfig(<analysis_key>)); analysis = an.analyze(symbol, df_htf, df_mtf, df_ltf); "
                           "analysis['squeeze_score'] = compute_squeeze_score(df_mtf); "
                           "sig = build_smc_signal(symbol, analysis, cfg_obj, **build_kwargs)")
            doc["signal_fields"] = "dataclasses.asdict(SMCSignalResult) + i, ts, open_time_ms, n_*_bars, squeeze_score, passes_ctx_gate, rr_ladder"
        else:
            doc["call"] = "sig = volume_strategy.analyze_volume(symbol, df, VolumeConfig.from_params(params), '1h', df_htf)"
            doc["signal_fields"] = "dataclasses.asdict(VolumeSignal) + tp, risk_pct, volume_ratio (properties) + i, ts, open_time_ms, n_bars, n_htf_bars, squeeze_score, quality_after_squeeze, passes_ctx_gate"
            doc["volume_env"] = {k: os.environ.get(k) for k in _UNSET_ENV}
        path = os.path.join(out_dir, "expected", f"{strat}.json")
        with open(path, "w") as fh:
            json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
        files[strat] = path
    path = os.path.join(out_dir, "expected", "smc_analysis.json")
    if not (keep and "smc" not in only):
        with open(path, "w") as fh:
            json.dump(dict(strategy="smc", note="per-bar digest of SMCAnalyzer.analyze() output for the DEFAULT variant's analysis key "
                                                "(keys = swept 1h index i); useful to localise a divergence to structure/liquidity/OB/FVG/PD",
                           analysis_key=variants["smc"]["default"]["analysis_key"], **common,
                           fixtures={sym: results[sym]["smc_digest"] for sym in symbols}), fh, ensure_ascii=False, separators=(",", ":"))
        files["smc_analysis"] = path

    # ── summary ──
    summary = {"strategies": {}, "fixtures": len(symbols), "sweep": common["sweep"], "env": env_record,
               "versions": {k: common[k] for k in ("python", "pandas", "numpy", "scipy")},
               "files": {k: os.path.relpath(v, out_dir) for k, v in files.items()},
               "sha256": {os.path.relpath(v, out_dir): _sha(v) for v in files.values()},
               "elapsed_s": round(time.time() - t_all, 1), "notes": []}
    for strat in ("levels", "smc", "volume"):
        if keep and strat not in only:
            continue
        per_variant = {}
        n_err = 0
        for v in variants[strat]:
            tot = sum(results[s][strat][v]["n_signals"] for s in symbols)
            fx_with = sum(1 for s in symbols if results[s][strat][v]["n_signals"] > 0)
            errs = sum(len(results[s][strat][v]["errors"]) for s in symbols)
            n_err += errs
            per_variant[v] = dict(signals=tot, fixtures_with_signals=fx_with, errors=errs,
                                  by_fixture={s: results[s][strat][v]["n_signals"] for s in symbols})
            if strat == "volume":
                per_variant[v]["scanner_prepass_mismatch_bars"] = sum(len(results[s][strat][v]["scanner_prepass_mismatch_bars"]) for s in symbols)
            if strat == "levels":
                agg: dict[str, int] = {}
                for s in symbols:
                    for r in results[s][strat][v]["reject_reasons"].values():
                        agg[r] = agg.get(r, 0) + 1
                per_variant[v]["reject_reason_counts"] = agg
        summary["strategies"][strat] = dict(signals=sum(x["signals"] for x in per_variant.values()), fixtures=len(symbols),
                                            variants=list(variants[strat]), per_variant=per_variant, errors=n_err)
    summary["notes"] = [
        "LEVELS: analyze() is called on a FRESH CHMIndicator per bar → no zone cache (TTL < bar duration in production anyway) and no COOLDOWN_BARS state (production marks cooldown only after Telegram delivery).",
        "LEVELS: momentum_detector relaxed mode OFF, market_regime cache empty (regime SL multiplier 1.0), SL_V2 flags off, LEVELS_REGIME_GATE=enforce (config default) → levels_filters/market_regime.detect_regime(df, tf='1h') runs inside _do_analyze and rejects trending markets (reject reason 'levels_filter').",
        "SMC: squeeze_score (c8 confirmation) is injected exactly like smc/scanner (compute_squeeze_score(df_mtf)).",
        "VOLUME: primary value = analyze_volume(df, cfg, '1h', df_htf); scanner_prepass_mismatch_bars lists bars where volume_scanner._analyze_with_htf's pre-pass (use_htf=False, min_quality-1) would have blocked a signal the direct call produced.",
        "Scanner-side bonuses that depend on LIVE state are NOT applied: trend_monitor.apply_mtf_bonus (BTC 15m/1H/4H trend → ±1), coin blacklist, momentum_veto (SMC), signal_freshness, signal_registry dedup, free-tier quotas, allow_counter_trend (needs live BTC regime).",
        "Pure post-analysis bonuses that ARE recorded as extra fields: squeeze boost (LEVELS quality+1 cap 10; VOLUME quality+1 cap 5 for non-bounce/ribbon setups) → quality_after_squeeze; profile min_quality gate → passes_min_quality / passes_ctx_gate.",
    ]
    if args.check:
        print("determinism check: re-running 3 fixtures ...", flush=True)
        chk = [s for s in symbols if s.startswith("SYNRG")][:1] + [s for s in symbols if s.startswith("SYNVL")][:1] + symbols[:1]
        ok = True
        for s in chk:
            again = run_fixture((s, out_dir, args.step, only))
            for strat in [x for x in ("levels", "smc", "volume") if not keep or x in only]:
                a = json.dumps(results[s][strat], sort_keys=True, ensure_ascii=False)
                b = json.dumps(again[strat], sort_keys=True, ensure_ascii=False)
                if a != b:
                    ok = False
                    print(f"  MISMATCH {s} {strat}", flush=True)
        summary["determinism_check"] = dict(fixtures=chk, identical=ok)
        print(f"  determinism identical={ok}", flush=True)
    if keep:
        # merge into the existing summary: only the regenerated strategies / files change
        with open(os.path.join(out_dir, "summary.json")) as fh:
            merged = json.load(fh)
        for strat in summary["strategies"]:
            merged["strategies"][strat] = summary["strategies"][strat]
        for rel, digest in summary["sha256"].items():
            merged["sha256"][rel] = digest
        if summary["versions"] != merged.get("versions"):
            raise SystemExit(f"--keep-others: versions differ from the kept files: {summary['versions']} != {merged.get('versions')}")
        merged["partial_regen"] = dict(only=list(only), elapsed_s=summary["elapsed_s"], bot_dir=BOT_DIR,
                                       determinism_check=summary.get("determinism_check"))
        summary = merged
    with open(os.path.join(out_dir, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1, ensure_ascii=False)
    # the bot writes signal_registry.json in cwd when the registry is touched — never leave it behind
    for junk in ("signal_registry.json",):
        p = os.path.join(BOT_DIR, junk)
        if os.path.exists(p):
            os.remove(p)
    print(json.dumps({k: {vv: summary["strategies"][k]["per_variant"][vv]["signals"] for vv in summary["strategies"][k]["per_variant"]}
                      for k in summary["strategies"]}, indent=1))
    if keep:
        print(f"merged into summary.json (only {', '.join(only)})", flush=True)
    print(f"total {summary['elapsed_s']}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
