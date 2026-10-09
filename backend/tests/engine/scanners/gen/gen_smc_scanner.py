"""gen_smc_scanner.py — differential vectors for the SMC scanner port (services/engine/smcScanner.js):
the bot's REAL smc/scanner._scan_cycle (+ _send_smc_card_bg, _on_ws_bar_close_smc) driven over
10 cycles on the golden candles with 16 users, a fake fetcher / candle cache / clock / Telegram.

Real bot modules under test: smc.scanner, smc.analyzer + signal_builder, signal_registry,
free_report, trend_monitor (seeded state + the D6 grade rule of PORT_DECISIONS), signal_confluence,
signal_freshness, momentum_veto, momentum_detector, volume_filter, market_regime.regime_allows_direction,
quiet_hours, position_size, watermark, i18n, signal_format, db/trades + db/trade_events +
db/signal_progress on the bot schema (temp SQLite), user_manager.UserManager.

Faked (the same fakes are replayed by the JS test from the scenario stored in the fixture):
cache.get_candles / get_coins (golden frames closed at the cycle time, per-(symbol, tf) failure
modes), the REST fetcher (scripted timeouts / errors), telegram_safe.safe_send_message (scripted
failures, message ids, on_sent), auto_trade.execute_auto_trade (rule table), exchange_symbols,
coin_quality_learner.is_blacklisted, optimizer.load_params, fundamental, smart_prompts,
chart_sender, balance_cache, metrics.record, market_regime.get_cached_regime, random.randint
(deterministic; the trade-id draws are recorded), time.time / datetime.now, asyncio.sleep inside
smc.scanner (instant; durations recorded).

Recorded per step: Telegram sends, chart calls, auto-trade calls, smart prompts, sleeps, metrics,
the trades and trade_events tables, the registry, the preview dedup map + its kv value, the free
users' preview counters, _SMC_LAST_SCAN, INFO+ log lines of every involved module and the DEBUG
lines of CHM.SMC.Scanner, the trade-id random draws.

Run (read-only use of the bot checkout; writes only the fixture):
  cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && PYTHONDONTWRITEBYTECODE=1 BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \\
    <PY311> <site>/backend/tests/engine/scanners/gen/gen_smc_scanner.py
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import asyncio
import gzip
import json
import logging
import math
import os
import random
import sys
import tempfile
import time as _time
from datetime import datetime, timezone
from types import SimpleNamespace

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
HERE = os.path.dirname(os.path.abspath(__file__))
SITE_BACKEND = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
CANDLES = os.path.join(SITE_BACKEND, "tests", "golden", "candles")
OUT = os.path.join(HERE, "..", "fixtures", "smc_scanner.json.gz")
os.chdir(BOT)
sys.path.insert(0, BOT)
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
for _k in ("CACHE_FIRST_MODE", "MOMENTUM_VETO_ENABLED", "SIGNAL_MAX_DRIFT_R", "TREND_MTF_BONUS",
           "TREND_STRONG_PCT", "TREND_STRONG_COUNTER_PENALTY", "TREND_CTX_RISK", "ENVIRONMENT"):
    os.environ.pop(_k, None)
# a throw-away Fernet key: db._encrypt_key would otherwise probe the bot's own chm_bot.db for users
# with API keys and sys.exit(1)
from cryptography.fernet import Fernet  # noqa: E402

os.environ["BYBIT_FERNET_KEY"] = Fernet.generate_key().decode()

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

NOW = [0.0]
_time.time = lambda: NOW[0]

import auto_trade  # noqa: E402
import balance_cache  # noqa: E402
import cache as bot_cache  # noqa: E402
import chart_sender  # noqa: E402
import coin_quality_learner  # noqa: E402
import database  # noqa: E402
import exchange_symbols  # noqa: E402
import free_report  # noqa: E402
import market_regime  # noqa: E402
import metrics  # noqa: E402
import momentum_detector  # noqa: E402
import optimizer  # noqa: E402
import signal_confluence  # noqa: E402
import signal_registry  # noqa: E402
import smart_prompts  # noqa: E402
import smc.scanner as sc  # noqa: E402
import trend_monitor  # noqa: E402
from smc.signal_builder import GRADES  # noqa: E402
from user_manager import UserManager, UserSettings  # noqa: E402

TMP = tempfile.mkdtemp(prefix="m9b_smc_")
signal_registry._PERSIST_PATH = os.path.join(TMP, "signal_registry.json")
signal_registry._registry.clear()


class FakeDT(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime.fromtimestamp(NOW[0], tz)


sc.datetime = FakeDT
free_report.datetime = FakeDT

# ── scenario ────────────────────────────────────────────────────────────────
T_END = 1767225600            # 2026-01-01 00:00 UTC — the last golden 1h bar closes here
FAR = 1_900_000_000.0
SYMBOLS = [
    ["BTC-USDT-SWAP", 5.0e9], ["ETH-USDT-SWAP", 2.0e9], ["SYNUP01-USDT-SWAP", 80e6],
    ["SYNUP02-USDT-SWAP", 45e6], ["SYNUP04-USDT-SWAP", 30e6], ["SYNUP07-USDT-SWAP", 12e6],
    ["SYNDN01-USDT-SWAP", 60e6], ["SYNDN02-USDT-SWAP", 9e6], ["SYNDN04-USDT-SWAP", 7e6],
    ["SYNRG02-USDT-SWAP", 4e6], ["SYNRG05-USDT-SWAP", 3e6], ["SYNRG08-USDT-SWAP", 2.5e6],
    ["SYNVL02-USDT-SWAP", 1.2e6], ["PEPEVL07-USDT-SWAP", 55e6], ["DOGEVL08-USDT-SWAP", 25e6],
    ["SYNLV02-USDT-SWAP", 250_000.0], ["SYNLV04-USDT-SWAP", 900_000.0],
]
COINS = [s for s, _v in SYMBOLS]
VOL = {s: v for s, v in SYMBOLS}
# cache modes per (symbol, tf): short = 20 bars in the cache (REST has the full frame),
# none = no cache entry; REST modes: timeout2 = two "Read timeout" then OK, error = ValueError,
# null = REST returns None
CACHE_MODE = {("SYNVL02-USDT-SWAP", "15m"): "short", ("SYNDN04-USDT-SWAP", "1H"): "none",
              ("SYNRG08-USDT-SWAP", "4H"): "none", ("SYNLV04-USDT-SWAP", "15m"): "none",
              ("SYNUP07-USDT-SWAP", "1D"): "none"}
REST_MODE = {("SYNDN04-USDT-SWAP", "1H"): "timeout2", ("SYNRG08-USDT-SWAP", "4H"): "error",
             ("SYNLV04-USDT-SWAP", "15m"): "null"}
UNAVAILABLE = {"bingx": ["SYNUP02-USDT-SWAP", "SYNDN01-USDT-SWAP"]}
BLACKLIST = [["SYNRG02-USDT-SWAP", "SMC"]]
OPT_PARAMS = {"113": {"min_rr": 3.0, "min_quality": 4}}
API_KEYS = {"110": ["k110", "s110"], "111": ["k111", "s111"], "116": ["k116", "s116"], "117": ["k117", "s117"]}
FUND = "🌡 Страх/Жадность: <b>55</b> (Нейтрально 😐) <i>— рынок нейтрален</i>"
TREND_SETS = {
    "aligned_long": {"trends": {"15m": "LONG", "1H": "LONG", "4H": "LONG"}, "strength": {"15m": 55, "1H": 60, "4H": 48}},
    "strong_short": {"trends": {"15m": "SHORT", "1H": "LONG", "4H": "LONG"}, "strength": {"15m": 82, "1H": 40, "4H": 51}},
    "range": {"trends": {"15m": "RANGE", "1H": "SHORT", "4H": "SHORT"}, "strength": {"15m": 30}},
    "none": {"trends": {}, "strength": {}},
}
# auto-trade fake: per (uid, symbol) rule, else the uid default
AT_RULES = {
    "110": {"default": {"executed": True, "show_trade_btn": False, "limit_msg": None},
            "SYNUP01-USDT-SWAP": {"executed": False, "show_trade_btn": True, "limit_msg": "⚠️ Достигнут лимит сделок (5)"},
            "SYNDN01-USDT-SWAP": {"executed": False, "show_trade_btn": True, "limit_msg": "⚠️ Достигнут лимит сделок (5)"},
            "DOGEVL08-USDT-SWAP": "raise"},
    "111": {"default": {"executed": False, "show_trade_btn": False, "limit_msg": None}},
    "117": {"default": {"executed": True, "show_trade_btn": False, "limit_msg": None}},
}


def close_ts(i):
    return float(T_END - (399 - i) * 3600)


CYCLES = [
    # op, index of the 1h bar that just closed, extra seconds, trend set, regime, fund, cache-first mode, fails, relaxed
    {"op": "cycle", "i": 338, "dt": 0, "trend": "aligned_long", "regime": "trending_up", "fund": "", "cf": None, "fail": ["card:102"]},
    {"op": "cycle", "i": 339, "dt": 0, "trend": "aligned_long", "regime": "trending_up", "fund": FUND, "cf": None, "fail": ["preview:107#1"]},
    {"op": "cycle", "i": 339, "dt": 1800, "trend": "aligned_long", "regime": "trending_up", "fund": "", "cf": None, "fail": []},
    {"op": "cycle", "i": 340, "dt": 0, "trend": "strong_short", "regime": "trending_up", "fund": "", "cf": None, "fail": ["card:105"]},
    {"op": "barclose", "i": 340, "dt": 60, "inst": "SYNUP01-USDT-SWAP", "tf": "15m"},
    {"op": "barclose", "i": 340, "dt": 61, "inst": "SYNUP01-USDT-SWAP", "tf": "1h"},
    {"op": "cycle", "i": 342, "dt": 0, "trend": "strong_short", "regime": None, "fund": "", "cf": "shadow", "fail": []},
    {"op": "cycle", "i": 343, "dt": 0, "trend": "strong_short", "regime": None, "fund": "", "cf": "shadow", "fail": []},
    {"op": "cycle", "i": 346, "dt": 0, "trend": "range", "regime": None, "fund": "", "cf": "enforce", "fail": [], "relax": True},
    {"op": "cycle", "i": 350, "dt": 0, "trend": "range", "regime": "trending_down", "fund": "", "cf": None, "fail": []},
    {"op": "cycle", "i": 351, "dt": 0, "trend": "none", "regime": "trending_down", "fund": "", "cf": None, "fail": []},
    {"op": "cycle", "i": 352, "dt": 0, "trend": "none", "regime": "trending_down", "fund": "", "cf": None, "fail": []},
]
for c in CYCLES:
    c["t"] = close_ts(c["i"]) + c["dt"]
DAY0 = datetime.fromtimestamp(CYCLES[0]["t"], timezone.utc).strftime("%Y-%m-%d")

PRO = {"sub_plan": "pro", "sub_status": "active", "sub_expires": FAR}
USERS = [
    [101, dict(PRO, strategy="SMC", smc_long_active=True, smc_short_active=True, lang="ru")],
    [102, dict(PRO, strategy="SMC", smc_long_active=True, smc_short_active=False, lang="en", signal_format="lite")],
    [103, dict(PRO, strategy="SMC", smc_long_active=True, smc_short_active=True,
               smc_cfg=json.dumps({"tf_key": "4H", "ob_max_age": 60, "sweep_close_req": False}))],
    [104, dict(PRO, strategy="SMC", smc_long_active=True, smc_short_active=True, send_chart_enabled=False,
               smc_cfg=json.dumps({"tf_key": "15m", "scan_interval": 7200}))],
    [105, dict(PRO, strategy="LEVELS", long_active=True, extra_strategies="SMC", smc_long_active=True, smc_short_active=True)],
    [106, {"sub_plan": "free", "strategy": "LEVELS", "long_active": True, "lang": "ru"}],
    [107, {"sub_plan": "free", "strategy": "SMC", "smc_long_active": True, "lang": "en"}],
    [108, dict(PRO, strategy="SMC", smc_long_active=True, smc_short_active=True, high_wr_mode=True,
               quiet_start=22, quiet_end=7, smc_max_sl_pct=0.5, trade_risk_pct=2.0, trade_leverage=5)],
    [109, dict(PRO, strategy="SMC", smc_long_active=True, smc_short_active=True,
               smc_cfg=json.dumps({"min_volume_usdt": 50000000, "direction": "SHORT"}))],
    [110, dict(PRO, strategy="SMC", smc_long_active=True, smc_short_active=True, auto_trade=True,
               allow_counter_trend=False, lang="en", trade_risk_pct=1.5)],
    [111, dict(PRO, strategy="SMC", smc_long_active=True, smc_short_active=True, auto_trade=True,
               allow_counter_trend=True, smc_counter_trend_min_quality=0, auto_trade_mode="auto",
               smc_cfg=json.dumps({"min_confirmations": 2}))],
    [112, dict(PRO, strategy="SMC", smc_long_active=True, smc_short_active=True, trade_exchange="bingx",
               smc_cfg="{bad json")],
    [113, dict(PRO, strategy="SMC", smc_long_active=True, smc_short_active=True, optimizer_enabled=True)],
    [114, {"sub_plan": "pro", "sub_status": "expired", "sub_expires": 0.0, "strategy": "SMC",
           "smc_long_active": True, "smc_short_active": True}],
    [115, {"sub_plan": "free", "strategy": "SMC", "smc_short_active": True,
           "free_smc_preview_today": 3, "free_smc_preview_date": DAY0}],
    [116, dict(PRO, strategy="SMC", smc_long_active=True, smc_short_active=True, auto_trade=True,
               allow_counter_trend=True, smc_counter_trend_min_quality=5, lang="en",
               smc_cfg=json.dumps({"min_confirmations": 2}))],
    [117, dict(PRO, strategy="SMC", smc_long_active=True, smc_short_active=True, auto_trade=True,
               allow_counter_trend=False, filters_all_off=True, smc_cfg=json.dumps({"min_confirmations": 2}))],
    [123, {"sub_plan": "free", "strategy": "SMC", "smc_long_active": True, "lang": "ru"}],
]

# ── frames ──────────────────────────────────────────────────────────────────
TF_FILE = {"15m": "15m", "1H": "1h", "4H": "4h", "1D": "1d"}
TF_MS = {"15m": 900_000, "1H": 3_600_000, "4H": 14_400_000, "1D": 86_400_000}
RAW = {}


def load_df(symbol, tf):
    with open(os.path.join(CANDLES, f"{symbol}_{TF_FILE[tf]}.json")) as fh:
        fx = json.load(fh)
    arr = np.array(fx["bars"], dtype=float)
    idx = pd.to_datetime(arr[:, 0].astype("int64"), unit="ms")
    df = pd.DataFrame({"open": arr[:, 1], "high": arr[:, 2], "low": arr[:, 3],
                       "close": arr[:, 4], "volume": arr[:, 5]}, index=idx)
    df.index.name = "open_time"
    return df


for _s in COINS:
    for _tf in TF_FILE:
        RAW[(_s, _tf)] = load_df(_s, _tf)


def closed(symbol, tf, now_s, window=300):
    df = RAW[(symbol, tf)]
    open_ms = df.index.asi8 // 1_000_000
    n = int(np.searchsorted(open_ms + TF_MS[tf], int(round(now_s * 1000)), side="right"))
    sub = df.iloc[:n]
    if window:
        sub = sub.iloc[-window:]
    return sub if len(sub) else None


FRAMES = {}      # (symbol, tf) → the cached frame of the current cycle (identity used for chart tf)
REST = {}


def build_frames(now_s):
    FRAMES.clear()
    REST.clear()
    for s in COINS:
        for tf in TF_FILE:
            full = closed(s, tf, now_s)
            REST[(s, tf)] = full
            mode = CACHE_MODE.get((s, tf))
            if mode == "none":
                continue
            FRAMES[(s, tf)] = full.iloc[-20:] if mode == "short" else full


async def fake_get_candles(symbol, tf):
    return FRAMES.get((symbol, tf))


async def fake_get_coins():
    return list(COINS)


bot_cache.get_candles = fake_get_candles
bot_cache.get_coins = fake_get_coins

REC = {}


def rec(name, item):
    REC.setdefault(name, []).append(item)


class Fetcher:
    def __init__(self):
        self.vol_by_sym = dict(VOL)
        self.attempts = {}

    async def get_all_usdt_pairs(self, min_volume_usdt=1_000_000, blacklist=None, max_coins=0):
        rec("pairs", [min_volume_usdt])
        return [s for s in COINS if VOL[s] >= min_volume_usdt]

    async def get_candles(self, symbol, tf, limit=300):
        key = (symbol, tf)
        n = self.attempts.get(key, 0)
        self.attempts[key] = n + 1
        rec("rest", [symbol, tf, limit])
        mode = REST_MODE.get(key)
        if mode == "timeout2" and n % 3 < 2:
            raise RuntimeError("Read timeout on endpoint")
        if mode == "error":
            raise ValueError("bad payload")
        if mode == "null":
            return None
        df = REST.get(key)
        return df.iloc[-limit:] if df is not None else None


FETCHER = Fetcher()


# ── asyncio.sleep inside smc.scanner: instant, recorded ─────────────────────
_real_sleep = asyncio.sleep


class _AsyncioShim:
    def __getattr__(self, name):
        return getattr(asyncio, name)

    async def sleep(self, delay, result=None):
        rec("sleeps", float(delay))
        await _real_sleep(0)
        return result


sc.asyncio = _AsyncioShim()

# ── deterministic randint; the trade-id draws recorded ──────────────────────
_rand_state = [0]


def fake_randint(a, b):
    _rand_state[0] += 1
    v = a + (_rand_state[0] * 7919) % (b - a + 1)
    if (a, b) == (100, 999):
        rec("rand", v)
    return v


random.randint = fake_randint

# ── Telegram ────────────────────────────────────────────────────────────────
MSG_ID = [1000]
FAILS = set()
FAIL_COUNT = {}


def kb_dump(rm):
    if rm is None:
        return None
    return rm.model_dump(exclude_none=True)


async def fake_safe_send(bot, user_id, text, *, parse_mode="HTML", reply_markup=None, protect_content=False,
                         disable_web_page_preview=False, retries=3, on_sent=None, disable_notification=False):
    if on_sent is not None:
        kind = "card"
    elif text.startswith("🎁 <b>Pro Preview"):
        kind = "preview"
    else:
        kind = "notice"
    tag = f"{kind}:{user_id}"
    FAIL_COUNT[tag] = FAIL_COUNT.get(tag, 0) + 1
    ok = not (tag in FAILS or f"{tag}#{FAIL_COUNT[tag]}" in FAILS)
    rec("sends", {"uid": int(user_id), "kind": kind, "text": text, "kb": kb_dump(reply_markup),
                  "protect": bool(protect_content), "silent": bool(disable_notification),
                  "parse_mode": parse_mode, "ok": ok})
    if ok and on_sent is not None:
        MSG_ID[0] += 1
        on_sent(SimpleNamespace(message_id=MSG_ID[0], html_text=text, text=text, reply_markup=reply_markup))
    return ok


sc.safe_send_message = fake_safe_send


def fake_chart(bot, user, sig, df, strategy="LEVELS", lang="ru", extra_signal_data=None, **kw):
    last_ts = int(df.index.asi8[-1] // 1_000_000) if df is not None and len(df) else None
    rec("charts", {"uid": int(user.user_id), "symbol": sig.symbol, "strategy": strategy, "lang": lang,
                   "bars": int(len(df)) if df is not None else 0, "last_ts": last_ts, "extra": extra_signal_data})


chart_sender.send_signal_chart_bg = fake_chart


async def fake_execute_auto_trade(**kw):
    rec("auto_trade", {k: kw.get(k) for k in ("user_id", "symbol", "direction", "entry", "sl", "tp1", "tp2", "tp3",
                                              "trade_id", "api_key", "api_secret", "risk_pct", "leverage",
                                              "auto_trade_mode", "max_trades", "strategy", "exchange", "bybit_demo",
                                              "entry_low", "entry_high", "quality", "trend_ctx")})
    rules = AT_RULES.get(str(kw["user_id"]), {})
    r = rules.get(kw["symbol"], rules.get("default", {"executed": False, "show_trade_btn": False, "limit_msg": None}))
    if r == "raise":
        raise RuntimeError("exchange down")
    return dict(r)


auto_trade.execute_auto_trade = fake_execute_auto_trade


def fake_is_available(okx_symbol, exchange, *, strict=False):
    return okx_symbol not in UNAVAILABLE.get((exchange or "").lower(), [])


exchange_symbols.is_available = fake_is_available
exchange_symbols.record_skip = lambda exchange, symbol: rec("skips", [exchange, symbol])
coin_quality_learner.is_blacklisted = lambda sym, strat: [sym, strat] in BLACKLIST


async def fake_load_params(uid, strategy):
    return dict(OPT_PARAMS[str(uid)]) if strategy == "SMC" and str(uid) in OPT_PARAMS else None


optimizer.load_params = fake_load_params
FUND_NOW = [""]


async def fake_fund():
    return FUND_NOW[0]


sc._FUND_OK = True
sc._fund = SimpleNamespace(get_market_context_block=fake_fund)


async def fake_prompt(bot, uid):
    rec("prompts", int(uid))


smart_prompts.trigger_after_quota_hit = fake_prompt


async def fake_balance(user, exchange):
    return None


balance_cache.get_cached_balance = fake_balance


async def fake_metric(name, value, tags=None):
    rec("metrics", [name, dict(tags or {})])


metrics.record = fake_metric
REGIME = [None]
market_regime.get_cached_regime = lambda: REGIME[0]

# [D6] PORT_DECISIONS: the SMC strong-counter penalty recomputes the grade (the site's trendMonitor)
_orig_bonus = trend_monitor.apply_mtf_bonus


def apply_mtf_bonus_d6(sig, attr="quality", cap=10):
    had = getattr(sig, "mtf_aligned", None) is not None
    ok = _orig_bonus(sig, attr=attr, cap=cap)
    if attr == "score" and not had and not ok and getattr(sig, "strong_counter", False) \
            and trend_monitor.STRONG_COUNTER_PENALTY > 0:
        sig.grade = GRADES.get(int(sig.score), sig.grade)
    return ok


trend_monitor.apply_mtf_bonus = apply_mtf_bonus_d6


def seed_trend(name):
    trend_monitor._state.clear()
    trend_monitor._strength.clear()
    ts = TREND_SETS[name]
    for tf, tr in ts["trends"].items():
        trend_monitor._state[tf] = {"trend": tr, "since": 0.0, "price": 0.0}
    for tf, s in ts["strength"].items():
        trend_monitor._strength[tf] = s


# ── logging ─────────────────────────────────────────────────────────────────
LOGGERS = ["CHM.SMC.Scanner", "CHM.SMC.SignalBuilder", "CHM.SignalRegistry", "CHM.SignalFreshness", "CHM.FreeReport", "CHM.MomentumVeto",
           "CHM.Momentum", "CHM.Confluence", "CHM.VolumeFilter", "CHM.DB", "CHM.TradeEvents", "CHM.PositionSize"]


class Capture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.lines = []

    def emit(self, record):
        self.lines.append([record.name, record.levelname, record.getMessage()])


CAP = Capture()
for _n in LOGGERS:
    _lg = logging.getLogger(_n)
    _lg.setLevel(logging.DEBUG)
    _lg.addHandler(CAP)
    _lg.propagate = False


def kept_logs():
    out = []
    for name, lvl, msg in CAP.lines:
        if msg.startswith("[SMC-PROFILE"):
            continue
        if lvl == "DEBUG" and name != "CHM.SMC.Scanner":
            continue
        out.append([name, lvl, msg])
    return out


# ── DB / users ──────────────────────────────────────────────────────────────
DBP = os.path.join(TMP, "bot.db")
LOOP = asyncio.new_event_loop()
asyncio.set_event_loop(LOOP)
TRADE_COLS = None


async def setup():
    global TRADE_COLS
    NOW[0] = CYCLES[0]["t"] - 3600
    await database.init_db(DBP)
    for uid, fields in USERS:
        f = dict(fields)
        if str(uid) in API_KEYS:
            f["bybit_api_key"], f["bybit_api_secret"] = API_KEYS[str(uid)]
        u = UserSettings(user_id=uid, **f)
        await database.db_upsert_user(u.to_db())


def sqlite_rows(sql):
    import sqlite3
    con = sqlite3.connect(DBP)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql).fetchall()]
    finally:
        con.close()


def fnum(x):
    if isinstance(x, float) and not math.isfinite(x):
        return {"$f": "nan" if math.isnan(x) else ("inf" if x > 0 else "-inf")}
    return x


def snapshot():
    rows = sqlite_rows("SELECT * FROM trades ORDER BY trade_id")
    events = sqlite_rows("SELECT trade_id, event_type, payload_json FROM trade_events ORDER BY trade_id, event_type, payload_json")
    users = sqlite_rows("SELECT user_id, free_smc_preview_today, free_smc_preview_date, long_active, short_active, "
                        "smc_long_active, smc_short_active, active FROM users ORDER BY user_id")
    kv = sqlite_rows("SELECT key, value FROM kv WHERE key IN ('free_preview_sent') ORDER BY key")
    reg = {"|".join(str(p) for p in k): v for k, v in signal_registry._registry.items()}
    return {
        "rows": [{k: fnum(v) for k, v in r.items()} for r in rows],
        "events": events,
        "users": users,
        "kv": kv,
        "registry": dict(sorted(reg.items())),
        "preview_sent": {str(k): dict(v) for k, v in free_report._FREE_PREVIEW_SENT.items()},
        "last_scan": {str(k): v for k, v in sorted(sc._SMC_LAST_SCAN.items())},
        "confluence": {f"{k[0]}|{k[1]}": [list(x) for x in v] for k, v in sorted(signal_confluence._recent.items())},
    }


async def drain():
    cur = asyncio.current_task()
    for _ in range(50):
        pend = [t for t in asyncio.all_tasks() if t is not cur and not t.done()]
        if not pend:
            return
        await asyncio.gather(*pend, return_exceptions=True)


async def run():
    await setup()
    um = UserManager()
    sc._SMC_UM_REF = um
    analyzer = sc.SMCAnalyzer(sc.SMCConfig())
    steps = []
    for k, c in enumerate(CYCLES):
        NOW[0] = c["t"]
        REC.clear()
        CAP.lines.clear()
        if c["op"] == "barclose":
            await sc._on_ws_bar_close_smc(c["inst"], c["tf"])
            step = {"op": "barclose", "t": c["t"], "inst": c["inst"], "tf": c["tf"]}
        else:
            build_frames(c["t"])
            seed_trend(c["trend"])
            REGIME[0] = c["regime"]
            FUND_NOW[0] = c["fund"]
            FAILS.clear()
            FAILS.update(c["fail"])
            FAIL_COUNT.clear()
            if c["cf"]:
                os.environ["CACHE_FIRST_MODE"] = c["cf"]
            else:
                os.environ.pop("CACHE_FIRST_MODE", None)
            if c.get("relax"):
                momentum_detector.activate_relaxed("BTC", "test pump +2.6% за 1H", 2.6, 1.1)
            await um.invalidate_cache()
            sc._scan_start_ts = _time.time()
            err = None
            try:
                await sc._scan_cycle(None, um, FETCHER, analyzer)
            except Exception as e:  # noqa: BLE001
                err = f"{type(e).__name__}: {e}"
            await drain()
            step = {"op": "cycle", "t": c["t"], "error": err}
        await drain()
        step.update(snapshot())
        step["rec"] = {k: v for k, v in REC.items()}
        step["logs"] = kept_logs()
        steps.append(step)
        print(c["op"], k, "sends", len(REC.get("sends", [])), "rows", len(step["rows"]), "logs", len(step["logs"]))
    return steps


steps = LOOP.run_until_complete(run())

doc = {
    "generator": "tests/engine/scanners/gen/gen_smc_scanner.py",
    "python": sys.version.split()[0], "pandas": pd.__version__, "numpy": np.__version__,
    "scenario": {
        "symbols": SYMBOLS, "cache_mode": [[k[0], k[1], v] for k, v in CACHE_MODE.items()],
        "rest_mode": [[k[0], k[1], v] for k, v in REST_MODE.items()], "unavailable": UNAVAILABLE,
        "blacklist": BLACKLIST, "opt_params": OPT_PARAMS, "api_keys": API_KEYS, "at_rules": AT_RULES,
        "trend_sets": TREND_SETS, "cycles": CYCLES, "users": USERS, "admin_ids": [123], "msg_id0": 1000,
    },
    "steps": steps,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with gzip.GzipFile(OUT, "wb", mtime=0) as fh:
    fh.write(json.dumps(doc, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"))
print("wrote", OUT, flush=True)
# the bot's aiosqlite read-pool threads are never closed → a plain exit would hang in threading._shutdown
os._exit(0)
