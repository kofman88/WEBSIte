"""adv_drive.py — adversarial differential driver of the THREE bot scanners in one process
(scanner_mid.MidScanner._cycle, smc.scanner._scan_cycle + its background card tasks,
volume_scanner._scan_cycle), the trend monitor (trend_monitor.refresh → broadcasts) and the free
evening report, for backend/tests/engine/scanners/adv/adv_scan.test.js.

Independent of the per-scanner drivers in ../py and ../gen: its own fakes, its own seed
(SEED below), its own market (golden candles + recorded mutations), its own users.

One shared bot process like bot.py: one signal_registry, one free_report, one confluence /
freshness / momentum / trend state, one UserManager (30 s active-users cache shared by the
three scanners), one REST fetcher (vol_by_sym shared), one candle cache (LRU cap 70 → evictions).
Each tick runs, in a seeded order: WS bar-close triggers → trend_monitor.refresh(bot) →
the three scanner cycles (permuted per tick) → the evening report at 21:xx.

Faked (the bot's network / exchange edges only):
  clock      time.time, datetime.datetime.now/utcnow, smc.scanner's time.monotonic → CLK.t
  sleeps     asyncio.sleep inside scanner_mid / smc.scanner / trend_monitor / free_report /
             volume_scanner → recorded, then sleep(0)
  random     random.randint → MINSTD stream shared with the JS replay (SEQ below)
  telegram   FakeBot.send_message: records every call; message_id = FNV-1a(uid|text|kb);
             uids in BOT_FAIL raise TelegramForbiddenError
  market     FakeFetcher (REST over the mutated golden frames, BingX get_all_usdt_pairs semantics
             incl. its 120 s pairs cache), the WS candle cache seeded per tick (modes below)
  exchange   auto_trade.execute_auto_trade → recorded, canned per (uid, symbol) rule;
             balance_cache.get_cached_balance → canned per uid
  misc       chart_sender.send_signal_chart_bg / metrics.record / smart_prompts → recorded;
             fundamental block per tick; market_regime cached regime per tick
PORT_DECISIONS D6 applied to the bot side (the site's intended behaviour): candle-cache keys use
ws_feed._TF_NORM; the SMC strong-counter penalty recomputes the grade.

The fakes suspend like the real I/O they stand for (await sleep(0) in send_message / REST),
so gather() interleavings match the JS promises. Snapshots are deep copies taken when a step /
tick ends (module lists keep growing). The SMC background card tasks interleave freely in the
bot (aiosqlite threads), so adv_compare.js compares their effects as multisets.

Run (read-only use of the bot checkout; ~2 min):
  cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && PYTHONDONTWRITEBYTECODE=1 BOT_TOKEN_CHM=test:token \
     ADMIN_IDS=123 <py311> <site>/backend/tests/engine/scanners/adv/py/adv_drive.py [OUT]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
Exploration (not committed): ADV_SEED=<n> (other users / ticks / failures), ADV_RANDOM_TIMES=1
(a random 19-tick timeline keeping both evening reports), ADV_MAX_TICKS=<n>, ADV_PROFILE=<file>,
ADV_DEBUG_DRAIN=1 (tasks still pending after a drain). Replay + diff any such fixture with
adv_replay.replay() and adv_compare.compare().
"""
from __future__ import annotations

import asyncio
import copy
import datetime as _dtmod
import gzip
import hashlib
import json
import logging
import math
import os
import random
import struct
import sys
import tempfile
import time as _time

sys.dont_write_bytecode = True
BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
HERE = os.path.dirname(os.path.abspath(__file__))
SITE_BACKEND = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", ".."))
GOLDEN = os.path.join(SITE_BACKEND, "tests", "golden", "candles")
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "..", "fixtures", "adv_scan.json.gz")

os.chdir(BOT)
sys.path.insert(0, BOT)
os.environ["BOT_TOKEN_CHM"] = "test:token"
os.environ["ADMIN_IDS"] = "123"
for _k in list(os.environ):
    if _k.startswith(("CACHE_FIRST", "LEVELS_", "SIGNAL_MAX", "MOMENTUM_VETO", "TREND_", "FRESHNESS_",
                      "POST_CLOSE", "SMC_", "VOLUME_", "DATA_SOURCE")):
        os.environ.pop(_k, None)
TMP = tempfile.mkdtemp(prefix="adv_scan_")
os.environ["DB_PATH"] = os.path.join(TMP, "bot.db")
from cryptography.fernet import Fernet  # noqa: E402

os.environ["BYBIT_FERNET_KEY"] = Fernet.generate_key().decode()

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402


# ── clock ─────────────────────────────────────────────────────────────────
class Clock:
    t = 0.0

    def time(self):
        return self.t


CLK = Clock()
_time.time = CLK.time
_RealDT = _dtmod.datetime


class FakeDT(_RealDT):
    @classmethod
    def now(cls, tz=None):
        return _RealDT.fromtimestamp(CLK.t, tz)

    @classmethod
    def utcnow(cls):
        return _RealDT.utcfromtimestamp(CLK.t)


_dtmod.datetime = FakeDT     # `from datetime import datetime` in the bot modules → FakeDT


# ── random.randint: MINSTD stream (shared with the JS replay) ─────────────
class Seq:
    """randint(a, b) = a + s_k mod (b − a + 1), s_{k+1} = s_k · 48271 mod (2^31 − 1); draws in
    STUCK repeat the previous value (forced trade-id collisions)."""

    def __init__(self, seed: int, stuck=()):
        self.s = seed
        self.k = 0
        self.last = None
        self.stuck = set(stuck)
        self.draws = []

    def randint(self, a, b):
        if self.k in self.stuck and self.last is not None:
            v = self.last
        else:
            self.s = (self.s * 48271) % 2147483647
            v = a + self.s % (b - a + 1)
        self.k += 1
        self.last = v
        self.draws.append(v)
        return v


SEED = int(os.environ.get("ADV_SEED", "917331"))   # the committed fixture: 917331; other seeds explore
SEQ = Seq(SEED % 2147483646 + 1, stuck=(7, 8, 31, 55, 56, 90))
random.randint = SEQ.randint
R = random.Random(SEED)       # scenario generator (instance methods are not patched)

import aiogram.exceptions as _aex  # noqa: E402
from aiogram.methods import SendMessage  # noqa: E402

import auto_trade  # noqa: E402
import balance_cache  # noqa: E402
import cache  # noqa: E402
import chart_sender  # noqa: E402
import coin_quality_learner  # noqa: E402
import database  # noqa: E402
import exchange_symbols  # noqa: E402
import free_report  # noqa: E402
import market_regime  # noqa: E402
import metrics  # noqa: E402
import momentum_detector  # noqa: E402
import signal_confluence  # noqa: E402
import signal_freshness  # noqa: E402
import signal_registry  # noqa: E402
import smart_prompts  # noqa: E402
import trend_monitor  # noqa: E402
import ws_feed  # noqa: E402
import scanner_mid  # noqa: E402
import smc.scanner as sc  # noqa: E402
import volume_scanner  # noqa: E402
from config import Config  # noqa: E402
from smc.signal_builder import GRADES  # noqa: E402
from user_manager import UserManager, UserSettings  # noqa: E402

T = lambda s: _RealDT.fromisoformat(s).replace(tzinfo=_dtmod.timezone.utc).timestamp()  # noqa: E731

# ── D6 on the bot side ────────────────────────────────────────────────────
cache._candle_key = lambda symbol, tf: f"{symbol}_{ws_feed._TF_NORM.get(tf, tf)}"
_orig_bonus = trend_monitor.apply_mtf_bonus


def _bonus_d6(sig, attr="quality", cap=10):
    had = getattr(sig, "mtf_aligned", None) is not None
    ok = _orig_bonus(sig, attr=attr, cap=cap)
    if attr == "score" and not had and not ok and getattr(sig, "strong_counter", False) \
            and trend_monitor.STRONG_COUNTER_PENALTY > 0:
        sig.grade = GRADES.get(int(sig.score), sig.grade)
    return ok


trend_monitor.apply_mtf_bonus = _bonus_d6

# ── sleeps / monotonic inside the scanners ────────────────────────────────
SLEEPS = []
_real_sleep = asyncio.sleep


class _AsyncioShim:
    def __getattr__(self, name):
        return getattr(asyncio, name)

    async def sleep(self, delay, result=None):
        SLEEPS.append(round(float(delay), 6))
        await _real_sleep(0)
        return result


class _TimeShim:
    def __getattr__(self, name):
        return getattr(_time, name)

    def time(self):
        return CLK.t

    def monotonic(self):
        return CLK.t


for _m in (scanner_mid, sc, trend_monitor, free_report, volume_scanner):
    _m.asyncio = _AsyncioShim()
sc.time = _TimeShim()

# ── candles: golden + recorded mutations ──────────────────────────────────
TF_MS = {"15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
TF_FILE = {"15m": "15m", "1h": "1h", "1H": "1h", "4h": "4h", "4H": "4h", "1d": "1d", "1D": "1d"}
SYMBOLS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SYNUP01-USDT-SWAP", "SYNUP03-USDT-SWAP", "SYNUP05-USDT-SWAP",
           "SYNUP08-USDT-SWAP", "SYNDN02-USDT-SWAP", "SYNDN04-USDT-SWAP", "SYNDN06-USDT-SWAP",
           "SYNDN07-USDT-SWAP", "SYNRG01-USDT-SWAP", "SYNRG03-USDT-SWAP", "SYNRG06-USDT-SWAP",
           "SYNRG08-USDT-SWAP", "SYNVL02-USDT-SWAP", "SYNVL05-USDT-SWAP", "PEPEVL07-USDT-SWAP",
           "DOGEVL08-USDT-SWAP", "SYNLV03-USDT-SWAP", "SYNLV07-USDT-SWAP"]
MS = lambda s: int(T(s) * 1000)  # noqa: E731
# op, symbol, tf, args — applied in order to the full golden arrays [t, o, h, l, c, v]
MUTATIONS = [
    ["gap", "SYNUP05-USDT-SWAP", "15m", MS("2025-12-30T18:00:00"), MS("2025-12-30T21:00:00")],
    ["gap", "SYNRG01-USDT-SWAP", "1h", MS("2025-12-31T03:00:00"), MS("2025-12-31T05:00:00")],
    ["flat", "SYNRG06-USDT-SWAP", "1h", MS("2025-12-31T02:00:00"), MS("2025-12-31T09:00:00")],
    ["flat", "PEPEVL07-USDT-SWAP", "15m", MS("2025-12-31T09:00:00"), MS("2025-12-31T11:00:00")],
    ["flat", "SYNRG08-USDT-SWAP", "15m", MS("2025-12-31T19:00:00"), MS("2025-12-31T20:15:00")],
    ["spike", "SYNVL05-USDT-SWAP", "15m", MS("2025-12-30T12:15:00"), 1.18, 1.0, 9.0],
    ["spike", "SYNVL05-USDT-SWAP", "1h", MS("2025-12-30T12:00:00"), 1.15, 1.0, 6.0],
    ["spike", "DOGEVL08-USDT-SWAP", "15m", MS("2025-12-31T05:30:00"), 1.0, 0.91, 8.0],
    ["spike", "DOGEVL08-USDT-SWAP", "15m", MS("2025-12-31T05:45:00"), 1.0, 0.9, 11.0],
    ["closemul", "DOGEVL08-USDT-SWAP", "15m", MS("2025-12-31T05:30:00"), MS("2025-12-31T06:00:00"), 0.93],
    ["spike", "SYNUP03-USDT-SWAP", "15m", MS("2025-12-30T05:30:00"), 1.25, 1.0, 12.0],
    ["closemul", "SYNUP03-USDT-SWAP", "15m", MS("2025-12-30T05:30:00"), MS("2025-12-30T06:00:00"), 1.07],
    ["jump", "SYNDN07-USDT-SWAP", "15m", MS("2025-12-31T00:00:00"), 1.12],
    ["jump", "SYNDN07-USDT-SWAP", "1h", MS("2025-12-31T00:00:00"), 1.12],
    ["jump", "SYNDN07-USDT-SWAP", "4h", MS("2025-12-31T00:00:00"), 1.12],
    ["listing", "SYNLV07-USDT-SWAP", "15m", MS("2025-12-30T10:00:00")],
    ["listing", "SYNLV07-USDT-SWAP", "1h", MS("2025-12-25T20:00:00")],
    ["listing", "SYNLV07-USDT-SWAP", "4h", MS("2025-12-05T00:00:00")],
    ["listing", "SYNLV07-USDT-SWAP", "1d", MS("2025-11-20T00:00:00")],
    ["volzero", "SYNUP08-USDT-SWAP", "1h", MS("2025-12-30T14:00:00"), MS("2025-12-30T20:00:00")],
    ["jump", "BTC-USDT-SWAP", "15m", MS("2025-12-30T11:00:00"), 0.972],
    ["jump", "BTC-USDT-SWAP", "15m", MS("2025-12-31T05:00:00"), 1.035],
    ["jump", "BTC-USDT-SWAP", "1h", MS("2025-12-31T05:00:00"), 1.035],
]


def _load(sym, tf):
    with open(os.path.join(GOLDEN, f"{sym}_{tf}.json")) as fh:
        return [list(map(float, b)) for b in json.load(fh)["bars"]]


RAW = {}
for _s in SYMBOLS:
    for _tf in ("15m", "1h", "4h", "1d"):
        RAW[(_s, _tf)] = _load(_s, _tf)
for m in MUTATIONS:
    op, sym, tf = m[0], m[1], m[2]
    bars = RAW[(sym, tf)]
    if op == "gap":
        RAW[(sym, tf)] = [b for b in bars if not (m[3] <= b[0] < m[4])]
    elif op == "flat":
        for i, b in enumerate(bars):
            if m[3] <= b[0] < m[4]:
                pc = bars[i - 1][4]
                b[1] = b[2] = b[3] = b[4] = pc
                b[5] = 0.0
    elif op == "spike":
        for b in bars:
            if b[0] == m[3]:
                b[2] = b[2] * m[4]
                b[3] = b[3] * m[5]
                b[5] = b[5] * m[6]
    elif op == "closemul":
        for b in bars:
            if m[3] <= b[0] < m[4]:
                b[4] = b[4] * m[5]
                b[2] = max(b[2], b[4])
                b[3] = min(b[3], b[4])
    elif op == "jump":
        for b in bars:
            if b[0] >= m[3]:
                b[1], b[2], b[3], b[4] = b[1] * m[4], b[2] * m[4], b[3] * m[4], b[4] * m[4]
    elif op == "listing":
        RAW[(sym, tf)] = [b for b in bars if b[0] >= m[3]]
    elif op == "volzero":
        for b in bars:
            if m[3] <= b[0] < m[4]:
                b[5] = 0.0
ARR = {k: np.array(v, dtype=float) for k, v in RAW.items()}


def market_digest():
    out = {}
    for (s, tf), a in sorted(ARR.items()):
        out[f"{s}|{tf}"] = hashlib.sha1(struct.pack("<%dd" % a.size, *a.ravel().tolist())).hexdigest()
    return out


def frame_at(sym, tf, now_s, limit=300):
    t = TF_FILE.get(tf)
    if t is None or (sym, t) not in ARR:
        return None
    a = ARR[(sym, t)]
    if not len(a):
        return None
    now_ms = int(now_s * 1000)
    n = int(np.searchsorted(a[:, 0] + TF_MS[t], now_ms, side="right"))
    sub = a[max(0, n - limit):n] if limit else a[:n]
    if not len(sub):
        return None
    df = pd.DataFrame({"open": sub[:, 1], "high": sub[:, 2], "low": sub[:, 3], "close": sub[:, 4],
                       "volume": sub[:, 5]}, index=pd.to_datetime(sub[:, 0].astype("int64"), unit="ms"))
    df.index.name = "open_time"
    return df


# ── market scenario ───────────────────────────────────────────────────────
VOLUMES = {}
for _s in SYMBOLS:
    if _s.startswith("BTC"):
        VOLUMES[_s] = 9.0e9
    elif _s.startswith("ETH"):
        VOLUMES[_s] = 4.0e9
    elif _s.startswith("SYNLV"):
        VOLUMES[_s] = float(round(R.uniform(8.0e4, 2.6e5), 2))
    else:
        VOLUMES[_s] = float(round(math.exp(R.uniform(math.log(1.5e5), math.log(6.0e8))), 2))
VOLUMES["SYNRG01-USDT-SWAP"] = 2.0e5          # exactly the SMC floor
VOLUMES["SYNDN04-USDT-SWAP"] = 3.0e5          # exactly the VOLUME floor
# cache modes: (symbol, tf) → "none" | ["short", n] | ["lag", seconds]
CACHE_MODE = {
    ("SYNRG08-USDT-SWAP", "15m"): "none", ("SYNRG08-USDT-SWAP", "1H"): "none",
    ("SYNRG08-USDT-SWAP", "4H"): "none", ("SYNRG08-USDT-SWAP", "1D"): "none",
    ("SYNVL02-USDT-SWAP", "15m"): ["short", 40],
    ("SYNVL02-USDT-SWAP", "1H"): ["short", 120],
    ("SYNDN02-USDT-SWAP", "1H"): ["lag", 3 * 3600 + 900],
    ("SYNDN02-USDT-SWAP", "15m"): ["lag", 1800],
    ("SYNUP01-USDT-SWAP", "4H"): "none",
    ("SYNLV03-USDT-SWAP", "1H"): "none",
    ("PEPEVL07-USDT-SWAP", "1D"): "none",
    ("SYNRG03-USDT-SWAP", "15m"): ["short", 25],
}
REST_MODE = {   # (symbol, tf) → "none" | "raise"
    ("SYNUP01-USDT-SWAP", "4h"): "raise", ("SYNUP01-USDT-SWAP", "4H"): "raise",
    ("SYNLV03-USDT-SWAP", "1h"): "none", ("SYNLV03-USDT-SWAP", "1H"): "none",
    ("SYNRG03-USDT-SWAP", "15m"): "raise",
}
CACHE_TFS = ("15m", "1H", "4H", "1D")
CACHE_MAX = 70
UNLISTED = {"bybit": ["SYNUP03-USDT-SWAP", "PEPEVL07-USDT-SWAP"],
            "bingx": ["SYNDN04-USDT-SWAP", "SYNRG01-USDT-SWAP", "SYNVL02-USDT-SWAP"],
            "binance": ["SYNVL05-USDT-SWAP", "SYNUP08-USDT-SWAP"], "okx": None}   # okx: empty listing (fail-open)
FAR = T("2026-03-01T00:00:00")


def _gen_users():
    """27 users: a few hand-made edge cases + seeded random ones."""
    users = []
    LV_PROFILES = [
        "{}",
        '{"min_rr": 1.5, "max_dist_pct": 3.0, "_sparse": true}',
        '{"pivot_strength": 5, "zone_pct": 1.0, "tp1_rr": 1.6, "_sparse": true}',
        '{"min_quality": 2, "cooldown_bars": 2, "_sparse": true}',
        '{"tp1_rr": 2.5, "tp2_rr": 4.0, "tp3_rr": 6.0, "_sparse": true}',
        '{bad json',
    ]
    SMC_PROFILES = [
        None,
        {"tf_key": "4H", "min_confirmations": 2},
        {"tf_key": "15m", "scan_interval": 900, "direction": "LONG"},
        {"min_volume_usdt": 0, "min_rr": 1.5, "sweep_close_req": False},
        {"tf_key": "2H", "ob_max_age": 40, "fvg_enabled": False},
        {"min_volume_usdt": 50000000, "direction": "SHORT", "choch_enabled": False},
        {"smc_pd_filter": True, "smc_mtf_check": True, "min_confirmations": 2, "min_rr": 1.8},
        "{not json",
    ]
    VOL_CFGS = [
        None,
        '{"min_quality": 2, "use_htf": false}',
        '{"min_quality": 1, "vol_mult": "1.2", "setup_ribbon": "yes", "use_htf": "off"}',
        '{"ma_type": " EMA ", "min_quality": 2.7, "ma_fast": "x", "use_htf": true}',
        '{"setup_cross": false, "setup_turn": false, "min_quality": 2, "max_sl_pct": 6.0, "use_htf": false}',
        "[1, 2]",
    ]
    PLANS = ["free"] * 7 + ["pro"] * 9 + ["pro_exp", "banned", "trial", "elite"]
    EXCH = ["bybit", "bybit", "bingx", "bingx", "binance", "okx", "OKX", "kraken"]
    for i in range(23):
        uid = 4001 + i
        plan = R.choice(PLANS)
        f = {}
        if plan == "free":
            f.update(sub_plan="free", sub_status=R.choice(["expired", "active", "trial"]), sub_expires=0.0)
        elif plan == "pro":
            f.update(sub_plan="pro", sub_status="active", sub_expires=FAR)
        elif plan == "pro_exp":
            f.update(sub_plan="pro", sub_status="active", sub_expires=T("2025-12-28T00:00:00"))
        elif plan == "banned":
            f.update(sub_plan=R.choice(["free", "pro"]), sub_status="banned", sub_expires=FAR)
        elif plan == "trial":
            f.update(sub_plan="pro", sub_status="trial", sub_expires=T("2026-01-05T00:00:00"))
        else:
            f.update(sub_plan="elite", sub_status="active", sub_expires=FAR)
        prim = R.choice(["LEVELS", "LEVELS", "SMC", "SMC", "VOLUME"])
        f["strategy"] = prim
        f["extra_strategies"] = R.choice(["", "", "SMC", "VOLUME", "LEVELS,SMC", "SMC,VOLUME",
                                          "levels, volume", "SMC,FOO", "LEVELS,SMC,VOLUME"])
        f["long_active"] = R.random() < 0.6
        f["short_active"] = R.random() < 0.5
        f["smc_long_active"] = R.random() < 0.6
        f["smc_short_active"] = R.random() < 0.5
        f["vol_long_active"] = R.random() < 0.6
        f["vol_short_active"] = R.random() < 0.5
        f["long_tf"] = R.choice(["15m", "15m", "1h", "1h", "4h", "30m"])
        f["short_tf"] = R.choice(["15m", "1h", "1h", "4h"])
        f["long_interval"] = R.choice([900, 1800, 3600])
        f["short_interval"] = R.choice([900, 1800, 3600, 7200])
        f["timeframe"] = R.choice(["1h", "15m"])
        f["scan_interval"] = R.choice([300, 900, 3600])
        f["long_cfg"] = R.choice(LV_PROFILES)
        f["short_cfg"] = R.choice(LV_PROFILES)
        f["min_quality"] = R.choice([1, 2, 3, 3, 4, 5, 6])
        f["trend_only"] = R.random() < 0.2
        f["use_htf"] = R.random() < 0.15
        f["high_wr_mode"] = R.random() < 0.15
        f["use_volume"] = R.random() < 0.8
        f["use_rsi"] = R.random() < 0.8
        f["cooldown_bars"] = R.choice([0, 2, 5, 5])
        f["min_volume_usdt"] = R.choice([0.0, 1.0e5, 3.0e5, 3.0e5, 5.0e6, 5.0e7])
        f["vol_filter_mode"] = R.choice(["usdt", "usdt", "count", "both", "off"])
        f["max_coins_count"] = R.choice([10, 30, 50])
        smc = R.choice(SMC_PROFILES)
        f["smc_cfg"] = "{}" if smc is None else (smc if isinstance(smc, str) else json.dumps(smc))
        f["vol_timeframe"] = R.choice(["15m", "1h", "1h", "4h", "5m", "1H"])
        f["lang"] = R.choice(["ru", "ru", "en", "en", "de"])
        f["signal_format"] = R.choice(["full", "full", "lite"])
        qs = R.choice([(-1, -1), (-1, -1), (22, 7), (5, 14), (12, 18), (0, 23), (9, 9)])
        f["quiet_start"], f["quiet_end"] = qs
        f["auto_trade"] = R.random() < 0.45
        f["trade_exchange"] = R.choice(EXCH)
        f["auto_trade_mode"] = R.choice(["confirm", "auto"])
        f["trade_risk_pct"] = R.choice([0.5, 1.0, 1.0, 1.5, 2.25, 3.0])
        f["trade_leverage"] = R.choice([1, 3, 5, 10, 20, 50])
        f["max_trades_limit"] = R.choice([0, 3, 5])
        f["allow_counter_trend"] = R.random() < 0.5
        f["levels_counter_trend_min_quality"] = R.choice([0, 3, 4, 5])
        f["smc_counter_trend_min_quality"] = R.choice([0, 2, 4, 5])
        f["filters_all_off"] = R.random() < 0.15
        f["send_chart_enabled"] = R.random() < 0.7
        f["notify_signal"] = R.random() < 0.9
        f["smc_max_sl_pct"] = R.choice([0.0, 0.8, 5.0])
        f["genome_auto_apply"] = R.random() < 0.3
        f["optimizer_enabled"] = R.random() < 0.15
        f["bybit_demo"] = R.random() < 0.2
        if f["sub_plan"] == "free" and R.random() < 0.5:
            f.update(free_signals_date="2025-12-30", free_signals_morning=R.choice([0, 1]),
                     free_signals_evening=0, free_signals_today=0)
        if f["sub_plan"] == "free" and R.random() < 0.4:
            f.update(free_smc_preview_date="2025-12-30", free_smc_preview_today=R.choice([1, 2, 3]))
        users.append([uid, f])
    # hand-made edge cases
    users += [
        [123, dict(sub_plan="free", sub_status="expired", strategy="LEVELS", extra_strategies="SMC,VOLUME",
                   long_active=True, short_active=True, long_tf="15m", short_tf="1h", long_interval=900,
                   short_interval=3600, smc_long_active=True, smc_short_active=True, vol_long_active=True,
                   vol_short_active=True, vol_timeframe="15m", lang="ru", min_quality=2)],
        # legacy BOTH job, both directions off → [LEVELS-BACKFILL]
        [4100, dict(sub_plan="pro", sub_status="active", sub_expires=FAR, strategy="LEVELS", active=True,
                    scan_mode="both", long_active=False, short_active=False, timeframe="15m",
                    scan_interval=900, lang="en", min_quality=1, vol_filter_mode="count", max_coins_count=12)],
        # Pro that expires mid-run → _notify_expired (LEVELS) / check_access (VOLUME, SMC)
        [4101, dict(sub_plan="pro", sub_status="active", sub_expires=T("2025-12-30T13:00:10"),
                    strategy="SMC", extra_strategies="LEVELS,VOLUME", long_active=True, short_active=True,
                    long_tf="15m", short_tf="15m", long_interval=900, short_interval=900,
                    smc_long_active=True, smc_short_active=True, vol_long_active=True, vol_short_active=True,
                    vol_timeframe="15m", lang="ru", min_quality=1)],
        # free with full counters + LONG only + blocked bot
        [4102, dict(sub_plan="free", sub_status="expired", strategy="LEVELS", long_active=True,
                    short_active=True, long_tf="15m", short_tf="15m", long_interval=900, short_interval=900,
                    lang="en", min_quality=1, free_signals_date="2025-12-30", free_signals_morning=1)],
        # multi-strategy Pro, every direction, auto-trade on bingx, all TF 15m → cross-strategy collisions
        [4103, dict(sub_plan="pro", sub_status="active", sub_expires=FAR, strategy="LEVELS",
                    extra_strategies="SMC,VOLUME", long_active=True, short_active=True, long_tf="15m",
                    short_tf="15m", long_interval=900, short_interval=900, smc_long_active=True,
                    smc_short_active=True, vol_long_active=True, vol_short_active=True, vol_timeframe="15m",
                    smc_cfg=json.dumps({"tf_key": "15m", "min_confirmations": 2, "min_volume_usdt": 0}),
                    auto_trade=True, trade_exchange="bingx", allow_counter_trend=True,
                    levels_counter_trend_min_quality=0, smc_counter_trend_min_quality=0, lang="ru",
                    min_quality=1, min_volume_usdt=0.0, genome_auto_apply=True)],
        # same as 4103 on bybit, lite, en, quiet always
        [4104, dict(sub_plan="pro", sub_status="active", sub_expires=FAR, strategy="SMC",
                    extra_strategies="LEVELS,VOLUME", long_active=True, short_active=True, long_tf="15m",
                    short_tf="15m", long_interval=900, short_interval=900, smc_long_active=True,
                    smc_short_active=True, vol_long_active=True, vol_short_active=True, vol_timeframe="15m",
                    smc_cfg=json.dumps({"tf_key": "15m", "min_confirmations": 2, "min_volume_usdt": 0}),
                    auto_trade=True, trade_exchange="bybit", allow_counter_trend=False, lang="en",
                    signal_format="lite", quiet_start=0, quiet_end=23, min_quality=1, min_volume_usdt=0.0)],
    ]
    return users


USERS = _gen_users()
BOT_FAIL = sorted({4001 + R.randrange(23) for _ in range(3)} | {4102})
KEYS = {}
for uid, f in USERS:
    if f.get("auto_trade") or R.random() < 0.3:
        ex = str(f.get("trade_exchange", "bybit") or "bybit")
        if R.random() < 0.85:
            KEYS[uid] = [ex, f"k{uid}", f"s{uid}"]
BALANCES = {}
for uid, _f in USERS:
    BALANCES[str(uid)] = R.choice([None, None, 0.0, 50.0, 87.5, 1234.56, 250000.0, -5.0, "raise"])
AT_MODES = ["exec", "btn", "limit", "none", "raise"]
AT_RULES = {str(uid): [R.choice(AT_MODES) for _ in range(3)] for uid, _f in USERS}
LIMIT_MSG = {"ru": "⚠️ Лимит сделок: 5/5 — новые позиции не открываются", "en": "⚠️ Trade limit: 5/5 — no new positions"}

# optimizer_params rows (genome auto-apply writes these): uid, strategy, params dict
OPT_INIT = [
    [4103, "LEVELS", {"min_rr": 1.6, "min_quality": 2, "_regime": {"trending_down": {"min_rr": 2.6, "min_quality": 5}}}],
    [4103, "SMC", {"min_rr": 2.2, "min_quality": 3}],
]
for uid, f in USERS:
    if f.get("genome_auto_apply") or f.get("optimizer_enabled"):
        if uid in (4103,):
            continue
        p = R.choice([
            {"min_rr": 2.4, "min_quality": 4},
            {"min_rr": 1.5, "_bayesian": {"symbol": "SYNUP01-USDT-SWAP", "params": {"min_quality": 6}}},
            {"min_quality": 0, "min_rr": 0},
            {"_regime": {"ranging": {"min_rr": 3.0}, "high_vol": {"min_quality": 5}}, "min_rr": 1.9},
            {"min_rr": 2.0, "min_quality": 3, "_regime": {"trending_up": {"min_quality": 1}}},
        ])
        OPT_INIT.append([uid, R.choice(["LEVELS", "SMC"]), p])

# kv before the first tick (scenario keys only)
KV_INIT = {
    "trend_state_v1": json.dumps({"15m": {"trend": "SHORT", "since": T("2025-12-29T10:00:00"), "price": 91000.0},
                                  "1H": {"trend": "RANGE", "since": T("2025-12-28T00:00:00"), "price": 0},
                                  "4H": {"trend": "LONG", "since": T("2025-12-20T00:00:00"), "price": 88000.5},
                                  "1D": {"trend": "SHORT", "since": 0, "price": 0},
                                  "5m": {"trend": "LONG"}}),
    "trend_aligned_v1": json.dumps({"dir": "", "since": T("2025-12-29T00:00:00")}),
    "coin_blacklist_v1": json.dumps({"SYNRG03-USDT-SWAP::LEVELS": T("2026-02-01T00:00:00"),
                                     "SYNDN06-USDT-SWAP::SMC": T("2026-02-01T00:00:00"),
                                     "SYNUP05-USDT-SWAP::VOLUME": T("2025-12-30T16:00:00"),
                                     "synvl05-usdt-swap::levels": T("2026-02-01T00:00:00"),
                                     "SYNUP08-USDT-SWAP::VOLUME": T("2025-12-01T00:00:00")}),
    "free_preview_sent": json.dumps({"4001": {"SYNUP01-USDT-SWAP:LONG": "2025-12-30"}}),
}
for uid, f in USERS:
    if R.random() < 0.2:
        KV_INIT[f"trend_notify_off_{uid}"] = "1"
    if R.random() < 0.15:
        KV_INIT[f"challenge_{uid}"] = json.dumps({"status": "active", "start_balance": 1000.0, "goal_usd": 2000.0,
                                                  "deadline": T("2026-01-20T00:00:00"), "risk_pct": 1.0,
                                                  "max_trades_day": 3, "notified": {}})
VOL_KV = {}
for uid, f in USERS:
    choice = R.choice(["None", "None", "1", "2", "3", "4", "5"])
    if choice != "None":
        VOL_KV[uid] = ["", '{"min_quality": 2, "use_htf": false}',
                       '{"min_quality": 1, "vol_mult": "1.2", "setup_ribbon": "yes", "use_htf": "off"}',
                       '{"ma_type": " EMA ", "min_quality": 2.7, "ma_fast": "x", "use_htf": true}',
                       '{"setup_cross": false, "setup_turn": false, "min_quality": 2, "max_sl_pct": 6.0, "use_htf": false}',
                       "[1, 2]"][int(choice)]
for uid, txt in VOL_KV.items():
    KV_INIT[f"volume_cfg_{uid}"] = txt

# ── ticks ─────────────────────────────────────────────────────────────────
TICK_TIMES = ["2025-12-30T05:45:20", "2025-12-30T06:00:20", "2025-12-30T06:15:20", "2025-12-30T08:00:20",
              "2025-12-30T12:00:20", "2025-12-30T12:45:20", "2025-12-30T13:00:20", "2025-12-30T16:00:20",
              "2025-12-30T20:00:20", "2025-12-30T20:30:20", "2025-12-30T21:00:20", "2025-12-30T23:45:20",
              "2025-12-31T00:00:20", "2025-12-31T06:00:20", "2025-12-31T06:00:50", "2025-12-31T12:15:20",
              "2025-12-31T13:00:20", "2025-12-31T20:15:20", "2025-12-31T23:00:20"]
if os.environ.get("ADV_RANDOM_TIMES"):   # exploration: a random timeline (both evening reports kept)
    _base = T("2025-12-30T05:00:00")
    _fixed = {T("2025-12-30T21:00:20"), T("2025-12-31T23:00:20")}
    _times = set(_fixed)
    while len(_times) < 19:
        _x = _base + R.randrange(168) * 900 + R.choice([20, 20, 20, 50, 320])   # 15-min slots up to 31st 23:00
        if _x - 20 not in {f - 20 for f in _fixed}:
            _times.add(_x)
    TICK_TIMES = [_RealDT.fromtimestamp(x, _dtmod.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") for x in sorted(_times)]
REGIMES =["trending_up", "trending_down", "ranging", "high_vol", None]
FUND_BLOCKS = ["", "", "", "📊 F&G: 61 (Жадность) · BTC.D 57.1%",
               "🌡 Страх/Жадность: <b>23</b> (Страх 😨) <i>— осторожно</i>\n💵 Funding: +0.012%"]


def _gen_ticks():
    ticks = []
    for i, ts in enumerate(TICK_TIMES):
        t = T(ts)
        tk = {"i": i, "at": ts, "t": t}
        order = ["LEVELS", "SMC", "VOLUME"]
        R.shuffle(order)
        tk["order"] = order
        tk["regime"] = R.choice(REGIMES)
        tk["regime_age"] = R.choice([60.0, 60.0, 600.0, 5 * 3600.0])     # 5 h → stale (get_cached_regime None)
        tk["fund"] = R.choice(FUND_BLOCKS)
        # WS bar-close triggers: (inst, tf_norm) of the bars that closed at this tick
        dt = _RealDT.fromtimestamp(t - 20, _dtmod.timezone.utc)
        trig = []
        if dt.minute % 15 == 0 and dt.second == 0:
            trig.append(["BTC-USDT-SWAP", "15m"])
            if dt.minute == 0:
                trig.append(["ETH-USDT-SWAP", "1H"])
                if dt.hour % 4 == 0:
                    trig.append(["BTC-USDT-SWAP", "4H"])
        tk["ws"] = trig
        tk["trend_seed"] = None
        tk["mutate"] = []
        tk["opt_update"] = []
        tk["closed"] = []
        tk["momentum"] = None
        tk["evening"] = ts.startswith("2025-12-30T21:00") or ts.startswith("2025-12-31T23:00")
        ticks.append(tk)
    # scripted events
    ticks[3]["momentum"] = {"symbol": "BTC", "reason": "BTC pump +2.40% за 1H", "btc": 2.4, "eth": 1.1}
    ticks[4]["trend_seed"] = {"15m": "LONG", "1H": "LONG", "4H": "LONG"}          # flips back on refresh → broadcast
    ticks[9]["trend_seed"] = {"4H": "SHORT", "1D": "LONG"}
    ticks[14]["trend_seed"] = {"15m": "RANGE"}
    ticks[2]["mutate"] = [[4100, "lang", "ru"], [4104, "signal_format", "full"]]
    ticks[5]["mutate"] = [[4102, "sub_plan", "pro"], [4102, "sub_status", "active"], [4102, "sub_expires", FAR]]
    ticks[7]["mutate"] = [[4103, "quiet_start", 15], [4103, "quiet_end", 17], [4104, "lang", "ru"]]
    ticks[12]["mutate"] = [[4102, "sub_plan", "free"], [123, "strategy", "SMC"]]
    # stored as the exact text written (like opt_init): json.dumps of the genome params
    ticks[6]["opt_update"] = [[4103, "LEVELS", json.dumps({"min_rr": 3.5, "min_quality": 7.0, "_bayesian": {"x": 1.0}})]]
    ticks[8]["closed"] = [["SYNUP01-USDT-SWAP", "LONG", 2.4], ["SYNDN04-USDT-SWAP", "SHORT", -1.0],
                          ["ETH-USDT-SWAP", "SHORT", 0.75]]
    ticks[17]["closed"] = [["DOGEVL08-USDT-SWAP", "LONG", 3.1]]
    return ticks


TICKS = _gen_ticks()
if os.environ.get("ADV_MAX_TICKS"):      # quicker iterations: the first N ticks of the same scenario
    TICKS = TICKS[:int(os.environ["ADV_MAX_TICKS"])]


# ── fakes ─────────────────────────────────────────────────────────────────
def fnv(s: str) -> int:
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def canon(x) -> str:
    return json.dumps(x, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def kb_dump(markup):
    if markup is None:
        return None
    d = getattr(markup, "model_dump", None)
    return d(exclude_none=True) if callable(d) else None


class FakeBot:
    def __init__(self):
        self.sent = []
        self.fail = set(BOT_FAIL)

    async def send_message(self, chat_id, text, **kw):
        kb = kb_dump(kw.get("reply_markup"))
        rec = {"uid": int(chat_id), "text": text, "parse_mode": kw.get("parse_mode"), "kb": kb,
               "protect": bool(kw.get("protect_content", False)),
               "silent": bool(kw.get("disable_notification", False))}
        self.sent.append(rec)
        await _real_sleep(0)          # the HTTP round trip: the real send suspends
        if int(chat_id) in self.fail:
            rec["ok"] = False
            raise _aex.TelegramForbiddenError(method=SendMessage(chat_id=chat_id, text="x"),
                                              message="Forbidden: bot was blocked by the user")
        mid = 10000 + fnv(f"{int(chat_id)}|{text}|{canon(kb)}") % 90000000
        rec["ok"] = True
        rec["message_id"] = mid
        from types import SimpleNamespace
        return SimpleNamespace(message_id=mid, html_text=text, text=text, reply_markup=kw.get("reply_markup"))


class FakeFetcher:
    """BingX fetcher contract: get_all_usdt_pairs → coins ≥ min by volume desc (capped), vol_by_sym =
    every coin ≥ min (before the cap), the 120 s per-key pairs cache (a hit does not touch
    vol_by_sym); REST candles = the mutated frames closed at the clock."""

    def __init__(self):
        self.vol_by_sym = {}
        self.calls = []
        self._pairs = {}

    async def get_candles(self, symbol, tf, limit=300):
        self.calls.append(["candles", symbol, tf, int(limit)])
        await _real_sleep(0)          # network I/O suspends
        mode = REST_MODE.get((symbol, tf))
        if mode == "raise":
            raise RuntimeError("rest down")
        if mode == "none":
            return None
        return frame_at(symbol, tf, CLK.t, int(limit))

    async def get_all_usdt_pairs(self, min_volume_usdt=1_000_000, blacklist=None, max_coins=0):
        blacklist = list(blacklist or [])
        key = f"pairs_{min_volume_usdt}_{max_coins}_{','.join(sorted(blacklist))[:200]}"
        hit = self._pairs.get(key)
        if hit and (CLK.t - hit["ts"]) < 120:
            self.calls.append(["pairs_cached", float(min_volume_usdt), int(max_coins)])
            return list(hit["coins"])
        self.calls.append(["pairs", float(min_volume_usdt), int(max_coins)])
        await _real_sleep(0)
        items = [(s, v) for s, v in VOLUMES.items() if v >= min_volume_usdt and s not in blacklist]
        items.sort(key=lambda x: x[1], reverse=True)
        self.vol_by_sym = {s: v for s, v in items}
        coins = [s for s, _ in items]
        if max_coins and max_coins > 0:
            coins = coins[:max_coins]
        self._pairs[key] = {"ts": CLK.t, "coins": list(coins)}
        return coins

    async def get_global_trend(self):
        self.calls.append(["global_trend"])
        await _real_sleep(0)
        return {"BTC": {"trend_text": "H1: 🟢 | H4: 🔴 | D1: ⚪ | W1: ❓"}, "ETH": {"trend_text": "H1: ⚪"}}


REC = {"charts": [], "at": [], "metrics": [], "prompts": []}


def _sym_rule(uid, symbol):
    rules = AT_RULES.get(str(uid)) or ["none"]
    return rules[sum(ord(c) for c in symbol) % len(rules)]


async def fake_execute_auto_trade(**kw):
    rec = {k: v for k, v in kw.items() if k != "bot"}
    REC["at"].append(rec)
    await _real_sleep(0)              # the exchange call suspends
    mode = _sym_rule(kw.get("user_id"), kw.get("symbol", ""))
    if mode == "raise":
        raise RuntimeError("exchange down")
    if mode == "exec":
        return {"executed": True, "show_trade_btn": False, "limit_msg": None}
    if mode == "btn":
        return {"executed": False, "show_trade_btn": True, "limit_msg": None}
    if mode == "limit":
        return {"executed": False, "show_trade_btn": False, "limit_msg": LIMIT_MSG["en" if int(kw["user_id"]) % 2 else "ru"]}
    return {"executed": False, "show_trade_btn": False, "limit_msg": None}


auto_trade.execute_auto_trade = fake_execute_auto_trade


async def fake_balance(user, exchange):
    v = BALANCES.get(str(user.user_id))
    await _real_sleep(0)
    if v == "raise":
        raise RuntimeError("balance api down")
    return v


balance_cache.get_cached_balance = fake_balance


def fake_chart(bot_, user, sig, df, strategy="LEVELS", lang="ru", pivot_levels=None, hvn_levels=None,
               lvn_levels=None, extra_signal_data=None, **kw):
    REC["charts"].append({"uid": int(user.user_id), "strategy": strategy, "lang": lang, "symbol": sig.symbol,
                          "bars": int(len(df)) if df is not None else 0,
                          "last": int(df.index.asi8[-1] // 1_000_000) if df is not None and len(df) else None,
                          "pivots": [float(x) for x in (pivot_levels or [])],
                          "hvn": [float(x) for x in (hvn_levels or [])], "lvn": [float(x) for x in (lvn_levels or [])],
                          "extra": extra_signal_data})


chart_sender.send_signal_chart_bg = fake_chart


async def fake_metric(name, value=1.0, tags=None, **kw):
    REC["metrics"].append([name, float(value), dict(tags or {})])


metrics.record = fake_metric


async def fake_prompt(bot, uid):
    REC["prompts"].append(int(uid))


smart_prompts.trigger_after_quota_hit = fake_prompt
FUND = {"block": ""}


async def fake_fund_block():
    return FUND["block"]


class _FundStub:
    get_market_context_block = staticmethod(fake_fund_block)


scanner_mid._FUND_OK = True
scanner_mid._fund = _FundStub
sc._FUND_OK = True
sc._fund = _FundStub
exchange_symbols._emit_metric_fire_and_forget = lambda *a, **k: None


# ── logs ──────────────────────────────────────────────────────────────────
class Capture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.INFO)
        self.lines = []

    def emit(self, record):
        if record.levelno < logging.INFO:
            return
        msg = record.getMessage()
        # metrics.mutation_log re-creates its queue + consumer task whenever `queue._loop` is not
        # the running loop (3.10+ binds it lazily), and the garbage collector reports the dropped
        # consumer whenever it happens to run — interpreter housekeeping, not scanner behaviour
        if record.name == "asyncio" and "mutation_log_consumer" in msg:
            return
        self.lines.append([record.name, record.levelname, msg])


CAP = Capture()


def _setup_logging():
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(CAP)
    for n in ("aiosqlite", "asyncio", "urllib3", "matplotlib", "PIL", "aiogram"):
        logging.getLogger(n).setLevel(logging.WARNING)


# ── encoders / snapshots ─────────────────────────────────────────────────
def enc(x):
    if isinstance(x, float) and not math.isfinite(x):
        return {"$f": "nan" if math.isnan(x) else ("inf" if x > 0 else "-inf")}
    if isinstance(x, np.floating):
        return enc(float(x))
    if isinstance(x, np.integer):
        return int(x)
    if isinstance(x, np.bool_):
        return bool(x)
    if isinstance(x, dict):
        return {str(k): enc(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [enc(v) for v in x]
    if isinstance(x, (set, frozenset)):
        return sorted(enc(v) for v in x)
    if isinstance(x, pd.Timestamp):
        return int(x.value // 1_000_000)
    return x


def rows(sql, params=()):
    import sqlite3
    con = sqlite3.connect(os.environ["DB_PATH"])
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql, params).fetchall()]
    finally:
        con.close()


async def drain():
    for _ in range(30):
        await _real_sleep(0)
    me = asyncio.current_task()
    # metrics.mutation_log's consumer is a forever loop (queue.get()); waiting on it only burns
    # the 10 s timeouts — its inserts (mutation_events) are not observed.
    forever = {"mutation_log_consumer"}
    for _ in range(5):
        pend = [t for t in asyncio.all_tasks() if t is not me and not t.done() and t.get_name() not in forever]
        if not pend:
            break
        _done, still = await asyncio.wait(pend, timeout=10)
        if still and os.environ.get("ADV_DEBUG_DRAIN"):
            for t in still:
                co = t.get_coro()
                fr = getattr(co, "cr_frame", None)
                print("[drain] pending", getattr(co, "__qualname__", co),
                      f"{fr.f_code.co_filename}:{fr.f_lineno}" if fr else "", file=sys.stderr, flush=True)
    for _ in range(30):
        await _real_sleep(0)


def snapshot_users():
    return rows("SELECT * FROM users ORDER BY user_id")


def snapshot_scanner_state(levels):
    indic = {jk: {s: int(pd.Timestamp(v).value // 1_000_000) for s, v in ind._last_signal.items()}
             for jk, ind in levels._indicators.items()}
    return {
        "levels_last_scan": dict(levels._last_scan),
        "levels_perf": dict(levels._perf),
        "levels_cooldowns": indic,
        "levels_hint": {str(k): v for k, v in scanner_mid._user_hint_last_ts.items()},
        "smc_last_scan": {str(k): v for k, v in sc._SMC_LAST_SCAN.items()},
        "vol_sent_bars": {"|".join(str(p) for p in k): v for k, v in volume_scanner._sent_bars.items()},
        "vol_htf": {f"{k[0]}|{k[1]}": [v[0], len(v[1]), int(v[1].index.asi8[-1] // 1_000_000)]
                    for k, v in volume_scanner._htf_cache.items()},
        "missed": {str(k): v for k, v in free_report._missed_buffer.items()},
        "closed": list(free_report._closed_profitable),
        "preview_sent": {str(k): dict(v) for k, v in free_report._FREE_PREVIEW_SENT.items()},
        "confluence": signal_confluence.get_stats(),
        "momentum": {"relaxed": bool(momentum_detector._state.relaxed),
                     "until": float(momentum_detector._state.relaxed_until)},
        "breakout": dict(momentum_detector._last_breakout_alert),
        "trend": {k: dict(v) for k, v in trend_monitor._state.items()},
        "strength": dict(trend_monitor._strength),
        "aligned": {k: v for k, v in trend_monitor._aligned.items()},
        "freshness_ema": {k: signal_freshness.get_cycle_ema(k) for k in ("LEVELS", "SMC", "VOLUME")},
        "skips": [exchange_symbols._skip_counter, dict(exchange_symbols._skip_samples)],
        "blacklist": {f"{k[0]}::{k[1]}": v for k, v in coin_quality_learner.get_blacklist_snapshot().items()},
        "cache": cache.cache_stats(),
        "registry": {"|".join(str(p) for p in k): v for k, v in signal_registry._registry.items()},
        "registry_stats": signal_registry.get_stats(),
        "rand_k": SEQ.k,
    }


def reg_file():
    p = signal_registry._PERSIST_PATH
    if os.path.exists(p):
        with open(p, encoding="utf-8") as fh:
            return fh.read()
    return None


# ── main ──────────────────────────────────────────────────────────────────
async def main():
    _setup_logging()
    CLK.t = TICKS[0]["t"] - 1800
    await database.init_db(os.environ["DB_PATH"])
    cache.init_cache(max_keys=CACHE_MAX)
    signal_registry._PERSIST_PATH = os.path.join(TMP, "signal_registry.json")
    signal_registry._registry.clear()
    signal_registry._stats.update({"allowed": 0, "blocked": 0})
    scanner_mid.Config.SCAN_WORKERS = 1

    from bybit_trader import to_bybit_symbol
    from bingx_trader import to_bingx_symbol
    from binance_trader import to_binance_symbol
    conv = {"bybit": to_bybit_symbol, "bingx": to_bingx_symbol, "binance": to_binance_symbol, "okx": lambda s: s}
    natives = {}
    for ex, miss in UNLISTED.items():
        natives[ex] = [] if miss is None else sorted(conv[ex](s) for s in SYMBOLS if s not in miss)
        exchange_symbols._symbols[ex] = set(natives[ex])
    exchange_symbols._updated_at = CLK.t
    exchange_symbols._skip_counter = 0
    exchange_symbols._skip_samples = {}

    kv_base = {r["key"]: r["value"] for r in rows("SELECT key, value FROM kv")}
    for k, v in KV_INIT.items():
        await database.db_kv_set(k, v)
    await coin_quality_learner.restore_blacklist_from_kv()
    await free_report.load_persistent_buffers()

    um = UserManager()
    for uid, fields in USERS:
        u = UserSettings(user_id=uid)
        for k, v in fields.items():
            setattr(u, k, v)
        if uid in KEYS:
            ex, key, sec = KEYS[uid]
            pre = {"bingx": "bingx", "binance": "binance", "okx": "okx"}.get(ex, "bybit")
            setattr(u, f"{pre}_api_key", key)
            setattr(u, f"{pre}_api_secret", sec)
        await um.save(u)
    init_rows = snapshot_users()
    for r in init_rows:
        for c in [c for c in r if c.endswith(("_api_key", "_api_secret", "_passphrase"))]:
            r[c] = ""
    import aiosqlite
    async with aiosqlite.connect(os.environ["DB_PATH"]) as con:
        for uid, strat, p in OPT_INIT:
            await con.execute("INSERT OR REPLACE INTO optimizer_params (user_id, strategy, params, updated_at) VALUES (?, ?, ?, ?)",
                              (uid, strat, json.dumps(p), CLK.t))
        await con.commit()

    bot = FakeBot()
    fetcher = FakeFetcher()
    levels = scanner_mid.MidScanner(Config, bot, um)
    levels.fetcher = fetcher
    sc._SMC_UM_REF = um
    smc_analyzer = sc.SMCAnalyzer(sc.SMCConfig())
    await trend_monitor.load_state()
    kv_after_setup = {r["key"]: r["value"] for r in rows("SELECT key, value FROM kv")}
    CAP.lines.clear()
    SLEEPS.clear()

    out = []
    prof = None
    if os.environ.get("ADV_PROFILE"):
        import cProfile
        prof = cProfile.Profile()
        prof.enable()
    for tk in TICKS:
        CLK.t = tk["t"]
        steps = []
        mark = {"sent": len(bot.sent), "logs": len(CAP.lines), "rest": len(fetcher.calls), "charts": len(REC["charts"]),
                "at": len(REC["at"]), "metrics": len(REC["metrics"]), "prompts": len(REC["prompts"]),
                "sleeps": len(SLEEPS), "trades": len(rows("SELECT trade_id FROM trades"))}

        def step(name):
            nonlocal mark
            tids = [r["trade_id"] for r in rows("SELECT trade_id FROM trades ORDER BY rowid")]
            s = {"step": name, "sent": bot.sent[mark["sent"]:], "logs": CAP.lines[mark["logs"]:],
                 "rest": fetcher.calls[mark["rest"]:], "charts": REC["charts"][mark["charts"]:],
                 "at": REC["at"][mark["at"]:], "metrics": REC["metrics"][mark["metrics"]:],
                 "prompts": REC["prompts"][mark["prompts"]:], "sleeps": SLEEPS[mark["sleeps"]:],
                 "new_trades": tids[mark["trades"]:], "registry_file": reg_file(),
                 "registry_state": {"|".join(str(p) for p in k): v for k, v in signal_registry._registry.items()}}
            steps.append(copy.deepcopy(s))      # the records and module lists keep changing later
            mark = {"sent": len(bot.sent), "logs": len(CAP.lines), "rest": len(fetcher.calls),
                    "charts": len(REC["charts"]), "at": len(REC["at"]), "metrics": len(REC["metrics"]),
                    "prompts": len(REC["prompts"]), "sleeps": len(SLEEPS), "trades": len(tids)}

        # live module state
        market_regime._cached_regime = tk["regime"]
        market_regime._cached_at = tk["t"] - tk["regime_age"]
        FUND["block"] = tk["fund"]
        if tk["momentum"]:
            m = tk["momentum"]
            momentum_detector.activate_relaxed(m["symbol"], m["reason"], m["btc"], m["eth"])
        for uid, field, value in tk["mutate"]:
            u = await um.get(uid)
            setattr(u, field, value)
            await um.save(u)
        if tk["opt_update"]:
            import aiosqlite
            async with aiosqlite.connect(os.environ["DB_PATH"]) as con:
                for uid, strat, p in tk["opt_update"]:
                    await con.execute("INSERT OR REPLACE INTO optimizer_params (user_id, strategy, params, updated_at) VALUES (?, ?, ?, ?)",
                                      (uid, strat, p, CLK.t))
                await con.commit()
        for sym, d, rr in tk["closed"]:
            free_report.record_closed_profitable(sym, d, rr)
        # the WS feed: closed bars into the candle cache
        for sym in SYMBOLS:
            for tf in CACHE_TFS:
                mode = CACHE_MODE.get((sym, tf))
                if mode == "none":
                    continue
                at, lim = CLK.t, 300
                if isinstance(mode, list) and mode[0] == "lag":
                    at = CLK.t - mode[1]
                elif isinstance(mode, list) and mode[0] == "short":
                    lim = mode[1]
                df = frame_at(sym, tf, at, lim)
                if df is not None:
                    await cache.set_candles(sym, tf, df, ws_feed._TTL_MAP)
        for inst, tf in tk["ws"]:
            await levels._on_ws_bar_close(inst, tf)
            await sc._on_ws_bar_close_smc(inst, tf)
            await volume_scanner._on_ws_bar_close(inst, tf)
        step("prep")
        # trend monitor (its own loop in the bot: refresh every 60 s)
        if tk["trend_seed"]:
            for tf, tr in tk["trend_seed"].items():
                trend_monitor._state[tf] = {"trend": tr, "since": tk["t"] - 7200.0, "price": 1.5}
        await trend_monitor.refresh(bot, now=CLK.t, fetcher=fetcher)
        await drain()
        step("trend")
        for name in tk["order"]:
            if name == "LEVELS":
                try:
                    await levels._cycle()
                except Exception as e:
                    CAP.lines.append(["driver", "ERROR", f"LEVELS cycle raised {type(e).__name__}: {e}"])
            elif name == "SMC":
                sc._scan_start_ts = CLK.t
                try:
                    await sc._scan_cycle(bot, um, fetcher, smc_analyzer)
                except Exception as e:
                    CAP.lines.append(["driver", "ERROR", f"SMC cycle raised {type(e).__name__}: {e}"])
            else:
                try:
                    await volume_scanner._scan_cycle(bot, um, fetcher)
                except Exception as e:
                    CAP.lines.append(["driver", "ERROR", f"VOLUME cycle raised {type(e).__name__}: {e}"])
            await drain()
            step(name)
        if tk["evening"]:
            await free_report._send_evening_report(bot, um)
            await drain()
            step("evening")
        trades = rows("SELECT * FROM trades ORDER BY rowid")
        events = rows("SELECT trade_id, ts, event_type, payload_json FROM trade_events")
        events.sort(key=lambda e: (e["trade_id"], e["event_type"], e["payload_json"]))
        kv_now = {r["key"]: r["value"] for r in rows("SELECT key, value FROM kv")}
        kv_diff = {k: v for k, v in kv_now.items() if kv_base.get(k) != v}
        opt = rows("SELECT user_id, strategy, params, updated_at FROM optimizer_params ORDER BY user_id, strategy")
        out.append({"steps": steps, "trades": trades, "events": events, "kv": kv_diff,
                    "kv_removed": sorted(k for k in kv_base if k not in kv_now),
                    "users": snapshot_users(), "state": copy.deepcopy(snapshot_scanner_state(levels)), "opt": opt})
        print(f"tick {tk['i']:2d} {tk['at']}: sends={sum(len(s['sent']) for s in steps)} "
              f"trades={len(trades)} logs={sum(len(s['logs']) for s in steps)}", flush=True)

    if prof is not None:
        prof.disable()
        prof.dump_stats(os.environ["ADV_PROFILE"])
    doc = {
        "meta": {"generator": "tests/engine/scanners/adv/py/adv_drive.py", "python": sys.version.split()[0],
                 "seed": SEED, "scan_workers": 1, "cache_max": CACHE_MAX},
        "symbols": SYMBOLS, "volumes": VOLUMES, "mutations": MUTATIONS, "market_digest": market_digest(),
        "cache_mode": [[s, tf, m] for (s, tf), m in CACHE_MODE.items()],
        "rest_mode": [[s, tf, m] for (s, tf), m in REST_MODE.items()],
        "cache_tfs": list(CACHE_TFS), "ttl_map": ws_feed._TTL_MAP, "exchange_symbols": natives,
        "users": init_rows, "api_keys": {str(k): v for k, v in KEYS.items()}, "bot_fail": BOT_FAIL,
        "balances": BALANCES, "at_rules": AT_RULES, "limit_msg": LIMIT_MSG,
        "opt_init": [[u, s, json.dumps(p)] for u, s, p in OPT_INIT],
        "kv_init": KV_INIT, "kv_after_setup": {k: v for k, v in kv_after_setup.items() if kv_base.get(k) != v},
        "seq": {"seed": SEED % 2147483646 + 1, "stuck": sorted(SEQ.stuck)},
        "start_t": TICKS[0]["t"] - 1800,
        "ticks": TICKS,
        "expected": out,
        "draws": SEQ.draws,
    }
    data = json.dumps(enc(doc), ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as raw_fh, gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=raw_fh, mtime=0) as fh:
        fh.write(data.encode("utf-8"))
    print("wrote", OUT, len(data), "bytes")
    return 0


if __name__ == "__main__":
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    rc = loop.run_until_complete(main())
    sys.stdout.flush()
    os._exit(rc)
