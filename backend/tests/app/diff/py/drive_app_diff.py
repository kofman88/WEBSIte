"""drive_app_diff.py — adversarial differential driver: the bot's own Mini App data handlers
(miniapp_api.py h_dashboard, h_signals, h_signal_chart, h_signal_result, h_stats, h_analyze,
h_share, h_feedback, plus aiohttp's router answers and the handlers' auth / POST bucket in front
of them) on CPython 3.11 / aiohttp 3.14, for backend/tests/app/diff/appDiff.test.js
(fixture tests/app/diff/fixtures/app_diff.json.gz).

Independent of tests/app/data/py/drive_app_data.py: its own seed (random.Random(20261009)), clock
(2026-01-01 05:20:34.75 UTC), users, rows, market fakes and chart mirror. The seed is built to
break things: 37 users across plans / langs / strategies (NULL plan, " PRO ", Elite, beginner,
starter, banned, expired pro, admin 123, a negative and a 10-digit uid, a user the bot has never
seen), ~650 trades with NULL in every nullable column, legacy values (GERCHIK / ORPHAN / TRAIL /
MANUAL / lowercase stages / '60' timeframes / BUY directions), TEXT in REAL columns, ancient
(0, negative, 1970) and future (2100, year 5138, year 10000) timestamps, huge / negative / infinite
R, unicode and emoji symbols, look-alike trade ids across users ('dup' / 'DUP' / 'dup '), numeric
looking ids ('0', '-1', '1e3', '01', 20 nines, NUL), trade_events with id gaps, hostile kv counters
(' 1 ', '1.0', '٣', '1_0', '-5', 20 digits, INT64 max) and seeded feedback ids with a gap.
Requests are hostile too: negative / huge / float / text / unicode-digit / 5000-digit page and
limit values, unknown strategy / tf / status filters, repeated keys, path ids 0, -1, 1e3, 01,
99999999999999999999, %00, %2F, %25, %ff, bodies over aiohttp's 1 MiB client_max_size, odd
charsets, lone surrogates, NaN / Infinity / 1e400 literals.

Per request the fixture keeps: status, the response headers that matter (content-type,
cache-control, retry-after, allow), the raw body bytes (base64) and — where the site answers by
decision D3 (chart / analyze PNG → chart data, share card → its numbers) — `expect`, the exact
json.dumps text the site must send, built from what the bot's renderer / share card received.
Side effects after the request: the touched trade row (every column + SQLite storage class) and
its trade_events (id, ts, type, payload), the trade_feedback row the bot's db_set_trade_result
writes, the uid's analyze / feedback kv counters, the feedback rows, the in-memory rate buckets
(post / chart / share) and the analyze cooldown, the market cache, the user row the handler may
create, and the [MINIAPP] / [MANUAL-RESULT] / [CHART-PMULT-MISMATCH] log lines.

Auth: miniapp_api._tg_user reads the test header X-Test-Uid (verify_init_data's own final check
`not user.get("id")` kept, so uid 0 is unauthorized); everything after it runs unchanged.
time.time is pinned per step; a fake bot object receives send_photo / send_message (share card,
admin feedback cards) so the production branches run.

  cd /home/user/MAIN_BOT/CHM_BREAKER_V4
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> -I -B <site>/backend/tests/app/diff/py/drive_app_diff.py [OUT]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import asyncio
import base64
import gzip
import hashlib
import json
import logging
import math
import os
import random
import sqlite3
import sys
import tempfile
import time as _time

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
HERE = os.path.dirname(os.path.abspath(__file__))
SITE_BACKEND = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
GOLDEN = os.path.join(SITE_BACKEND, "tests", "golden", "candles")
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "..", "fixtures", "app_diff.json.gz")
TMP = tempfile.mkdtemp(prefix="m10b_app_diff_")
DBP = os.path.join(TMP, "bot.db")
os.environ["DB_PATH"] = DBP
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
sys.dont_write_bytecode = True
os.chdir(BOT)
sys.path.insert(0, BOT)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

NOW = 1767244834.75          # 2026-01-01 05:20:34.75 UTC
CLOCK = [NOW]
_time.time = lambda: CLOCK[0]

import cache  # noqa: E402
import chart_renderer as cr  # noqa: E402
import database  # noqa: E402
import miniapp_api as api  # noqa: E402
import share_card  # noqa: E402
import trend_monitor as tm  # noqa: E402
from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestServer  # noqa: E402
from user_manager import UserManager  # noqa: E402

rng = random.Random(20261009)
DAY = 86400.0
TF_MS = {"15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
_gold: dict = {}


def golden_bars(name):
    if name not in _gold:
        with open(os.path.join(GOLDEN, f"{name}.json")) as fh:
            _gold[name] = json.load(fh)["bars"]
    return _gold[name]


def frame_bars(spec):
    """A frame spec → bars: golden `name_tf`, cut at close ≤ cut_ms, last n, prices × scale,
    `nan_close` = the closes of the last k bars set to NaN."""
    gtf = spec["golden"].rsplit("_", 1)[1]
    bars = [list(b) for b in golden_bars(spec["golden"])]
    if spec.get("cut_ms") is not None:
        bars = [b for b in bars if b[0] + TF_MS[gtf] <= spec["cut_ms"]]
    n = spec.get("n")
    if n is not None:
        bars = bars[-n:] if n > 0 else []
    k = float(spec.get("scale", 1.0))
    if k != 1.0:
        bars = [[b[0], b[1] * k, b[2] * k, b[3] * k, b[4] * k, b[5]] for b in bars]
    for i in range(int(spec.get("nan_close", 0) or 0)):
        if i < len(bars):
            bars[-1 - i][4] = float("nan")
    return bars


def to_df(bars):
    if bars is None:
        return None
    if not bars:
        return pd.DataFrame({c: pd.Series([], dtype=float) for c in ("open", "high", "low", "close", "volume")},
                            index=pd.DatetimeIndex([], name="open_time"))
    arr = np.array(bars, dtype=float)
    idx = pd.to_datetime(arr[:, 0].astype("int64"), unit="ms")
    df = pd.DataFrame({"open": arr[:, 1], "high": arr[:, 2], "low": arr[:, 3], "close": arr[:, 4],
                       "volume": arr[:, 5]}, index=idx)
    df.index.name = "open_time"
    return df


GSYMS = sorted({f.rsplit("_", 1)[0] for f in os.listdir(GOLDEN) if f.endswith(".json") and "_" in f})


def close_at(sym, ts):
    bars = golden_bars(f"{sym}_1h")
    ms = ts * 1000
    best = bars[0]
    for b in bars:
        if b[0] <= ms:
            best = b
        else:
            break
    return best[4]


# ── users ───────────────────────────────────────────────────────────────────
# uid, sub_plan, sub_status, sub_expires (rel. NOW, None = NULL), lang, strategy, admin
USERS = [
    (301, "pro", "active", 30 * DAY, "ru", "LEVELS", 0), (302, "pro", "active", 3 * DAY, "en", "SMC", 0),
    (303, "free", "active", 0, "ru", "VOLUME", 0), (304, "free", "expired", 0, "", "LEVELS", 0),
    (305, " PRO ", "active", 9 * DAY, "ru", "LEVELS", 0), (306, "Elite", "active", 20 * DAY, "en", "SMC", 0),
    (307, "beginner", "trial", 1 * DAY, "ru", "VOLUME", 0), (308, "starter", "active", 10 * DAY, "ru", "LEVELS", 0),
    (309, "trial", "trial", 2 * DAY, "ru", "LEVELS", 0), (310, "", "expired", 0, "ru", "", 0),
    (311, None, None, None, None, None, 0), (312, "pro", "banned", 30 * DAY, "ru", "LEVELS", 0),
    (313, "pro", "active", -10 * DAY, "ru", "LEVELS", 0), (314, "free", "active", 0, "de", "LEVELS", 0),
    (315, "free", "active", 0, None, "SMC", 0), (316, "pro", "active", 365 * DAY, "en", "VOLUME", 0),
    (317, "free", "active", 0, "ru", "LEVELS", 0), (318, "pro", "active", 12 * DAY, "ru", "SMC", 0),
    (319, "free", "active", 0, "en", "VOLUME", 0), (320, "pro", "active", 40 * DAY, "ru", "LEVELS", 0),
    (321, "free", "active", 0, "ru", "LEVELS", 0), (322, "pro", "active", 7 * DAY, "ru", "SMC", 0),
    (323, "free", "active", 0, "ru", "LEVELS", 0), (324, "pro", "active", 15 * DAY, "en", "LEVELS", 0),
    (325, "free", "active", 0, "ru", "VOLUME", 0), (326, "free", "active", 0, "ru", "LEVELS", 0),
    (327, "pro", "active", 2 * DAY, "ru", "LEVELS", 0), (328, "free", "active", 0, "ru", "SMC", 0),
    (329, "free", "active", 0, "ru", "LEVELS", 0), (330, "free", "active", 0, "ru", "LEVELS", 0),
    (331, "pro", "active", 5 * DAY, "ru", "LEVELS", 0), (332, "free", "active", 0, "ru", "LEVELS", 0),
    (333, "pro", "active", 50 * DAY, "ru", "VOLUME", 0), (334, "free", "active", 0, "en", "LEVELS", 0),
    (123, "free", "active", 0, "ru", "LEVELS", 1), (-7, "pro", "active", 30 * DAY, "ru", "LEVELS", 0),
    (7000000001, "free", "active", 0, "ru", "LEVELS", 0),
]
FRESH_UID = 399            # a JWT user the bot has no row for (get_or_create creates it)
UIDS = [u[0] for u in USERS]
# rows per user (the poison users 340-343 get hand-made rows below)
COUNTS = {301: 80, 302: 45, 303: 30, 304: 12, 305: 25, 306: 18, 307: 10, 308: 14, 309: 9, 310: 8, 311: 16, 312: 6,
          313: 22, 314: 7, 315: 11, 316: 35, 317: 5, 318: 28, 319: 9, 320: 40, 321: 0, 322: 20, 323: 4, 324: 26,
          325: 13, 326: 3, 327: 17, 328: 6, 329: 2, 330: 10, 331: 24, 332: 1, 333: 30, 334: 8, 123: 20, -7: 15,
          7000000001: 12}
POISON = [  # uid, what is poisoned
    (340, "created_at inf"), (341, "created_at TEXT 'abc'"), (342, "closed_pnl_usd TEXT"),
    (343, "created_at year 10000"), (344, "quality TEXT 'inf'"), (345, "entry TEXT"), (346, "created_at year 5138"),
    (347, "quality TEXT 'abc'"),
]
for uid, _ in POISON:
    USERS.append((uid, "pro", "active", 30 * DAY, "ru", "LEVELS", 0))
    UIDS.append(uid)

STRATS = ["LEVELS"] * 5 + ["SMC"] * 4 + ["VOLUME"] * 3 + ["levels", "Smc", " smc ", "GERCHIK", "scalping", "ГЕРЧИК",
                                                          "MA", "", None, "Levels", "LIQUIDATION"]
TFS = ["1h"] * 6 + ["4h"] * 3 + ["15m"] * 3 + ["1H", "4H", "1D", "1d", "30m", "5m", "60", "240", "1w", "", None, " 1h", "1h "]
DIRS = ["LONG"] * 6 + ["SHORT"] * 6 + ["long", "Short", "BUY", "", "sell"]
CTX = ["", "", "aligned", "with", "counter", "strong_counter", None, "COUNTER", "aligned ", "weird"]
UNICODE_SYMS = ["ПЕПЕ-USDT-SWAP", "🚀MOON-USDT-SWAP", "btc-usdt-swap", "ETH-USDT", "SOL", "1000PEPE-USDT-SWAP",
                "币安人生-USDT-SWAP", "Á-USDT-SWAP", "é-USDT", "X" * 40 + "-USDT-SWAP", "BTC-USDT-SWAP-USDT-SWAP",
                "A\u0000B-USDT-SWAP", "\u2028LS-USDT-SWAP"]

trades: list = []


def created_choice():
    r = rng.random()
    if r < 0.30:
        return NOW - rng.uniform(30, 72 * 3600)                     # live window
    if r < 0.55:
        return NOW - rng.uniform(72 * 3600, 7 * DAY)
    if r < 0.75:
        return NOW - rng.uniform(7 * DAY, 30 * DAY)
    if r < 0.85:
        return NOW - rng.uniform(30 * DAY, 400 * DAY)
    if r < 0.88:
        return rng.choice([0.0, 1.0, -DAY, 946684800.0, 1e9, -1e9])  # ancient
    if r < 0.91:
        return rng.choice([NOW + 3600.0, NOW + 400 * DAY, 4102444800.0])   # future (2100); year 5138 / 10000 → poison users
    if r < 0.94:
        return None                                                 # NULL created_at
    if r < 0.97:
        return float(int(NOW - rng.uniform(0, 20 * DAY)) // 3600 * 3600)   # hour-aligned ties
    return NOW - 72 * 3600 - rng.choice([-1.0, 0.0, 0.25, 1.0])      # the 72 h edge


def nullish(v, p=0.08):
    return None if rng.random() < p else v


def make_levels(sym, direction, created):
    if sym in GSYMS:
        entry = close_at(sym, created if isinstance(created, float) and 0 < created < NOW else NOW - DAY)
        if rng.random() < 0.05:
            entry *= 10.0                            # pmult mismatch → the renderer refuses
    else:
        entry = rng.choice([1.2345, 0.00012, 250.5, 1e-9, 123456.789, 0.0])
    s = -1 if str(direction).upper() in ("SHORT", "SELL") else 1
    risk = entry * rng.choice([0.004, 0.008, 0.012, 0.02, 0.0])
    lv = {"entry": entry, "sl": entry - s * risk, "tp1": entry + s * risk * rng.choice([1.0, 1.5, 2.0]),
          "tp2": entry + s * risk * rng.choice([2.5, 3.0]), "tp3": entry + s * risk * rng.choice([4.0, 4.5]),
          "tp1_rr": nullish(rng.choice([1.5, 2.0, 0.8, 0.0, -1.0])), "tp2_rr": nullish(rng.choice([3.0, 2.5])),
          "tp3_rr": nullish(rng.choice([4.5, 4.0, 1e300]))}
    v = rng.random()
    if v < 0.5:
        lv["original_sl"] = lv["sl"]
    elif v < 0.65:
        lv["original_sl"] = lv["sl"]
        lv["sl"] = entry                             # stop moved to break-even
    elif v < 0.75:
        lv["original_sl"] = 0.0
    elif v < 0.85:
        lv["original_sl"] = None
    else:
        lv["original_sl"] = rng.choice([entry, -lv["sl"], 1e308])
    if rng.random() < 0.05:
        lv["tp3"] = 0.0
    if rng.random() < 0.03:
        lv["tp1"] = -lv["tp1"]
    return lv


HUGE_R = [1e300, -1e300, 123456789.125, -5.5, -1e9, 0.0, -0.0, 2.675, 0.125, 1.005, 7.0, float("inf"), float("-inf"),
          1e-300, 99.995]


def outcome(r):
    k = rng.random()
    if k < 0.12:                                    # exchange trade
        r["order_id"] = rng.choice([f"ox{rng.randint(1, 10**6)}", " ox9 ", "None", "0"])
        r["result"] = rng.choice(["", "", "TP1", "TP2", "SL", "BE", "MANUAL", "TRAIL", "SKIP", "tp1", "CANCELLED", None])
        r["result_rr"] = rng.choice(HUGE_R + [round(rng.uniform(-1, 4), 3), None, "abc", "1.5"])
        r["signal_msg_id"] = rng.choice([0, 0, 13, None])
        if r["result"] not in ("", "SKIP", None) and rng.random() < 0.5:
            r["closed_pnl_usd"] = rng.choice([round(rng.uniform(-40, 80), 2), 1e10, -0.004, 0.005])
    elif k < 0.20:                                  # ghost / manual skip
        r["result"] = "SKIP"
        r["skip_reason"] = rng.choice(["ghost", "not_delivered", "", "manual", "MANUAL", None])
        r["signal_msg_id"] = rng.choice([0, 0, 22, None, -3])
        r["order_id"] = rng.choice(["", "", "  ", None])
        r["tp_placed"] = rng.choice([0, 0, 1, None])
    elif k < 0.23:
        r["result"] = rng.choice(["ORPHAN", "orphan", "WIN", "LOSS"])
    elif k < 0.31:                                  # manual results
        r["signal_msg_id"] = rng.choice([31, None, 0])
        r["result"] = rng.choice(["TP1", "TP2", "TP3", "SL", "BE", "SKIP", "MANUAL", "TRAIL", "Tp2", " SL"])
        r["result_rr"] = rng.choice([2.0, 3.0, 4.5, -1.0, 0.0, 0.6, -0.4, None, 1e300, -1e300])
        if r["result"] == "SKIP":
            r["skip_reason"] = "manual"
    else:                                           # tracker stages
        r["signal_msg_id"] = rng.choice([rng.randint(1, 999), rng.randint(1, 999), None, 0, "7"])
        r["progress_stage"] = rng.choice(["", "", "", "ENTRY", "TP1", "TP1", "TP2", "TP3", "SL", "BE", "EXPIRED",
                                          "MISSED", "tp2", "Expired", "missed", "BE ", None, "TP4"])
        if str(r["progress_stage"] or "").upper() == "EXPIRED":
            r["expire_rr"] = rng.choice([None, 0.125, -0.375, round(rng.uniform(-1, 2.5), 2), 1e300, "x", -0.0, 2.675])


TRADE_KEYS = ["trade_id", "user_id", "symbol", "direction", "entry", "sl", "tp1", "tp2", "tp3", "tp1_rr", "tp2_rr", "tp3_rr",
              "quality", "timeframe", "breakout_type", "result", "result_rr", "created_at", "order_id", "be_set", "tp_placed",
              "strategy", "state", "state_changed_at", "closed_pnl_usd", "original_sl", "skip_reason", "is_counter_trend",
              "mtf_aligned", "trend_ctx", "signal_msg_id", "progress_stage", "progress_ts", "expire_rr", "user_note",
              "exchange", "signal_type"]


def base_row(tid, uid, sym, direction, created):
    lv = make_levels(sym, direction, created)
    return {
        "trade_id": tid, "user_id": uid, "symbol": sym, "direction": direction, **lv,
        "quality": nullish(rng.choice([0, 1, 3, 5, 7, 10, 12, -2, 4.7, "8"])), "timeframe": nullish(rng.choice(TFS), 0.04),
        "breakout_type": rng.choice(["", "", "GERCHIK", None, "pivot"]), "result": rng.choice(["", "", None]) if rng.random() < 0.1 else "",
        "result_rr": rng.choice([0.0, 0.0, None]), "created_at": created, "order_id": rng.choice(["", "", "", None]),
        "be_set": rng.choice([0, 1, None]), "tp_placed": 0, "strategy": rng.choice(STRATS),
        "state": rng.choice(["OPEN", "CLOSED", "FAILED", None, "PENDING"]), "state_changed_at": rng.choice([0.0, NOW - 3 * DAY, None]),
        "closed_pnl_usd": None, "skip_reason": rng.choice(["", "", None]), "is_counter_trend": nullish(rng.choice([0, 0, 1, 2])),
        "mtf_aligned": nullish(rng.choice([0, 0, 1])), "trend_ctx": rng.choice(CTX), "signal_msg_id": 0,
        "progress_stage": "", "progress_ts": rng.choice([0.0, None]), "expire_rr": None,
        "user_note": rng.choice(["", "", "", "нота", "<b>x</b>", None, "😀 emoji", "a\"b\\c", "\u0007bell", "  pad  "]),
        "exchange": rng.choice(["bybit", "bingx", "", None]), "signal_type": rng.choice(["", "pivot", None]),
    }


seq = 0
for uid in [u[0] for u in USERS if u[0] in COUNTS]:
    for _ in range(COUNTS[uid]):
        seq += 1
        if rng.random() < 0.18:
            sym = rng.choice(UNICODE_SYMS + ["NOCANDLE-USDT-SWAP"])
        else:
            sym = rng.choice(GSYMS)
        direction = rng.choice(DIRS)
        created = created_choice()
        r = base_row(f"d{seq:04d}", uid, sym, direction, created)
        outcome(r)
        trades.append(r)

# ── hand-made rows (ids the route families rely on) ──────────────────────────
H = []


def hand(tid, uid, sym="BTC-USDT-SWAP", direction="LONG", strategy="LEVELS", tf="1h", created=NOW - 5 * 3600, keep=True, **kw):
    s = -1 if direction == "SHORT" else 1
    e = close_at(sym if sym in GSYMS else "BTC-USDT-SWAP", created if isinstance(created, float) and 0 < created < NOW else NOW - DAY)
    risk = e * 0.01
    r = {k: None for k in TRADE_KEYS}
    r.update({"trade_id": tid, "user_id": uid, "symbol": sym, "direction": direction, "entry": e, "sl": e - s * risk,
              "original_sl": e - s * risk, "tp1": e + s * risk * 1.5, "tp2": e + s * risk * 3.0, "tp3": e + s * risk * 4.5,
              "tp1_rr": 1.5, "tp2_rr": 3.0, "tp3_rr": 4.5, "quality": 6, "timeframe": tf, "breakout_type": "",
              "result": "", "result_rr": 0.0, "created_at": created, "order_id": "", "be_set": 0, "tp_placed": 0,
              "strategy": strategy, "state": "OPEN", "state_changed_at": 0.0, "skip_reason": "", "is_counter_trend": 0,
              "mtf_aligned": 0, "trend_ctx": "", "signal_msg_id": 41, "progress_stage": "", "progress_ts": 0.0,
              "user_note": "", "exchange": "bybit", "signal_type": ""})
    r.update(kw)
    if keep:
        H.append(r)
    return r


# look-alike / numeric ids across users
hand("dup", 301, created=NOW - 2 * 3600)
hand("DUP", 302, sym="ETH-USDT-SWAP", direction="SHORT", strategy="SMC", tf="4h", created=NOW - 9 * 3600)
hand("dup ", 303, sym="SYNUP01-USDT-SWAP", strategy="VOLUME", created=NOW - 26 * 3600)
hand("0", 301, sym="SYNDN01-USDT-SWAP", direction="SHORT", tf="15m", created=NOW - 3 * 3600)
hand("-1", 302, sym="SYNLV02-USDT-SWAP", created=NOW - 4 * 3600, progress_stage="TP1")
hand("1e3", 301, sym="ETH-USDT-SWAP", tf="1H", created=NOW - 6 * 3600, progress_stage="TP2")
hand("01", 301, sym="SYNRG01-USDT-SWAP", strategy="SMC", created=NOW - 30 * 3600, progress_stage="SL")
hand("1", 303, created=NOW - 7 * 3600)
hand("1000", 301, sym="SYNDN02-USDT-SWAP", tf="4H", created=NOW - 50 * 3600, progress_stage="TP3")
hand("99999999999999999999", 301, created=NOW - 8 * 3600, progress_stage="BE")
hand("\u0000", 301, created=NOW - 10 * 3600)
hand("a/b", 301, sym="ETH-USDT-SWAP", created=NOW - 11 * 3600)
hand("%41", 301, created=NOW - 12 * 3600)
hand("тест", 301, created=NOW - 13 * 3600, progress_stage="EXPIRED", expire_rr=0.625)
hand("😀", 301, created=NOW - 14 * 3600, progress_stage="MISSED")
hand("x" * 300, 301, created=NOW - 15 * 3600)
# result-route rows
hand("r-null", 301, created=NOW - 3 * 3600, result=None)                      # NULL result: the UPDATE never matches
hand("r-skip", 301, created=NOW - 3 * 3600, result="SKIP", skip_reason="ghost", tp_placed=1)
hand("r-exch", 301, created=NOW - 3 * 3600, order_id="ord-1")
hand("r-done", 301, created=NOW - 3 * 3600, result="MANUAL", result_rr=0.4)
hand("r-orphan", 301, created=NOW - 3 * 3600, result="ORPHAN")
hand("r-lower", 301, created=NOW - 3 * 3600, result="tp1")
hand("r-nostop", 301, created=NOW - 3 * 3600, sl=0.0, original_sl=None, tp1_rr=None, tp2_rr=2.675, tp3_rr=-1.0)
hand("r-osl0", 301, created=NOW - 3 * 3600, original_sl=0.0)
hand("r-texte", 345, created=NOW - 3 * 3600, entry="12,5")                    # float('12,5') → ValueError → 500
hand("r-huge", 301, created=NOW - 3 * 3600, entry=1e300, sl=-1e300, original_sl=None, tp1=1e308, tp2=-1e308, tp3=0.0)
hand("r-note", 301, created=NOW - 3 * 3600)
hand("r-sur", 301, created=NOW - 3 * 3600)
hand("r-302", 302, created=NOW - 3 * 3600)
hand("r-neg", -7, created=NOW - 3 * 3600)
hand("r-big", 7000000001, created=NOW - 3 * 3600)
hand("r-tpl", 301, created=NOW - 3 * 3600, result="", tp_placed=2)
hand("r-inf", 301, created=NOW - 3 * 3600, entry=1e-300, sl=0.0, original_sl=None, tp1=1e300, tp2=2e300, tp3=0.0)   # R = inf
hand("r-nan", 301, created=NOW - 3 * 3600, entry=float("inf"), sl=float("inf"), original_sl=None, tp1_rr=2.675)  # risk nan
hand("r-q", 347, created=NOW - 3 * 3600, quality="abc")      # int("abc"): every reader 500s; the feedback block skips the row
# chart-route rows
hand("c-future", 346, created=1e11, progress_stage="TP1")                     # pd.Timestamp(1e11, unit="s") overflows
hand("c-2100", 301, created=4102444800.0)
hand("c-neg", 301, created=-1e10, progress_stage="SL")                         # year 1653: out of pandas' range
hand("c-1970", 301, created=-86400.0 * 365 * 50, progress_stage="SL")         # 1920: in range
hand("c-zero", 301, created=0.0, progress_stage="TP2")                        # entry_time None → _guess_entry_idx
hand("c-null", 301, created=None, progress_stage="BE")
hand("c-30m", 301, tf="30m", created=NOW - 2 * 3600)                           # no cache, REST tf unknown → no_data
hand("c-60", 301, tf="60", created=NOW - 2 * 3600)
hand("c-1d", 301, tf="1d", created=NOW - 2 * 3600)
hand("c-short", 301, sym="SYNVL02-USDT-SWAP", created=NOW - 2 * 3600)        # REST 20 bars → no_data
hand("c-nan", 301, sym="SYNVL03-USDT-SWAP", created=NOW - 2 * 3600)          # cached closes with NaN tail
hand("c-pmult", 301, sym="ETH-USDT-SWAP", created=NOW - 2 * 3600, entry=52000.0)
hand("c-expired", 301, created=NOW - 80 * 3600)
hand("c-vol", 301, sym="SYNUP02-USDT-SWAP", strategy="VOLUME", tf="4h", created=NOW - 20 * 3600, progress_stage="TP1")
hand("c-uni", 301, sym="ПЕПЕ-USDT-SWAP", created=NOW - 2 * 3600)
hand("c-302", 302, created=NOW - 2 * 3600)
# poison rows (one user each)
# p-inf / p-abc poison every reader (the all-users rating too): inserted for the poison phase only
P_INF = hand("p-inf", 340, created=float("inf"), result="TP1", result_rr=2.0, keep=False)
P_ABC = hand("p-abc", 341, created="abc", keep=False)
hand("p-pnl", 342, created=NOW - 2 * DAY, result="SL", result_rr=-1.0, closed_pnl_usd="12.5$", order_id="ox-p")
hand("p-y10k", 343, created=253402300800.0, result="TP2", result_rr=3.0)
hand("p-qinf", 344, created=NOW - 3600.0, quality="inf")
hand("p-ok", 340, created=NOW - DAY, result="SL", result_rr=-1.0)
hand("p-ok2", 343, created=NOW - DAY, result="TP1", result_rr=1.5)
trades.extend(H)

# trade_events with id gaps (the next AUTOINCREMENT id is 1001)
EVENTS = []
_eid = [1, 2, 7, 50, 51, 1000]
for i, r in enumerate(rng.sample([t for t in trades if t["trade_id"].startswith("d")], 5) + [H[0]]):
    EVENTS.append({"id": _eid[i], "trade_id": r["trade_id"], "ts": NOW - 3600 + i, "event_type": "signal_generated",
                   "payload_json": json.dumps({"symbol": r["symbol"], "strategy": r["strategy"]}, ensure_ascii=False)})
EVENTS.append({"id": 3, "trade_id": "r-note", "ts": NOW - 50.5, "event_type": "notification_sent", "payload_json": ""})

IDAY = int(NOW) // 86400
KV = {
    f"analyze_count_303_{IDAY}": " 1 ",            # int(" 1 ") = 1 → quota used
    f"analyze_count_304_{IDAY}": "1.0",            # int("1.0") → ValueError → HTTP 500
    f"analyze_count_308_{IDAY}": "٣",              # int("٣") = 3 → used
    f"analyze_count_309_{IDAY}": "-5",             # -5 < 1 → allowed, CAST + 1 → '-4'
    f"analyze_count_310_{IDAY}": "1_0",            # int("1_0") = 10 → used
    f"analyze_count_314_{IDAY}": "99999999999999999999",
    f"analyze_count_315_{IDAY}": "",               # falsy → 0 → allowed; CAST('' AS INTEGER) + 1 = 1
    f"analyze_count_317_{IDAY - 1}": "1",          # yesterday
    f"analyze_count_319_{IDAY}": "0",
    f"miniapp_feedback_303_{IDAY}": "5",
    f"miniapp_feedback_304_{IDAY}": "9223372036854775807",   # CAST + 1 overflows → REAL text → int() fails → 1
    f"miniapp_feedback_305_{IDAY}": "x",           # CAST('x') = 0 → '1'
    f"miniapp_feedback_306_{IDAY}": "4.9",         # CAST('4.9' AS INTEGER) = 4 → '5' → allowed
    f"miniapp_feedback_307_{IDAY}": "-1",
    f"miniapp_feedback_308_{IDAY}": " 4 ",
    f"miniapp_feedback_309_{IDAY - 1}": "5",
}
FEEDBACK_SEED = [  # id, user_id, type, text
    (1, 301, "bug", "seeded one"), (2, 302, "feature", "seeded two"), (9, 303, "question", "seeded nine (gap)"),
]

# ── market data ─────────────────────────────────────────────────────────────
CACHE_SEED = []
for i, sym in enumerate(GSYMS):
    if i % 4 == 3:
        continue                                   # nothing cached → REST
    for tf, gtf in (("15m", "15m"), ("1H", "1h"), ("4H", "4h")):
        if tf == "4H" and i % 3 == 1:
            continue
        CACHE_SEED.append({"symbol": sym, "tf": tf, "golden": f"{sym}_{gtf}", "n": 300 if i % 5 else 59})   # 59 < 60 → REST
CACHE_SEED.append({"symbol": "SYNVL03-USDT-SWAP", "tf": "1H", "golden": "SYNVL03-USDT-SWAP_1h", "n": 300, "nan_close": 3})
CACHE_SEED.append({"symbol": "SYNVL03-USDT-SWAP", "tf": "15m", "golden": "SYNVL03-USDT-SWAP_15m", "n": 300, "nan_close": 1})
REST_SEED = {s: {"mode": "ok"} for s in GSYMS}
REST_SEED["SYNVL02-USDT-SWAP"] = {"mode": "short", "n": 20}
REST_SEED["SYNVL04-USDT-SWAP"] = {"mode": "none"}
REST_SEED["SYNVL05-USDT-SWAP"] = {"mode": "raise"}
REST_SEED["SYNVL06-USDT-SWAP"] = {"mode": "empty"}
REST_SEED["SYNDN03-USDT-SWAP"] = {"mode": "ok", "cut_ms": 1767182400000}
REST_SEED["SYNLV05-USDT-SWAP"] = {"mode": "ok", "cut_ms": 1766703600000}
TICKERS = {
    "BTC-USDT-SWAP": {"mode": "ok", "last": 73458.52026, "change_pct": 1.23456, "drift": 0.5},
    "ETH-USDT-SWAP": {"mode": "ok", "last": 5245.660744, "change_pct": -0.004999, "drift": -0.25},
    "SYNDN03-USDT-SWAP": {"mode": "ok", "last": 12.5, "change_pct": 2.675, "drift": 0},
    "SYNLV05-USDT-SWAP": {"mode": "ok", "last": "1_000.5", "change_pct": " 3.3 ", "drift": 0},
    "SYNRG02-USDT-SWAP": {"mode": "empty"},
    "SYNUP03-USDT-SWAP": {"mode": "ok", "last": True, "change_pct": None, "drift": 0},
    "SYNDN04-USDT-SWAP": {"mode": "ok", "last": "abc", "change_pct": 1, "drift": 0},
    "SYNLV06-USDT-SWAP": {"mode": "raise"},
}
TREND_RAW = {"BTC": {"trend_text": "H1: 🟢 | H4: 🔴 | D1: ⚪ | W1: ❓"},
             "ETH": {"trend_text": "60: 🔴 | 1: 🟢 | H4:🟢|__proto__: ⚪| constructor : 🔴 | 1: ⚪"}}
TREND_STATE = {"15m": {"trend": "LONG", "since": NOW - 3600.0, "price": 73458.52},
               "1H": {"trend": "SHORT", "since": 1767232800.0, "price": 73400.0},
               "4H": {"trend": "RANGE", "since": NOW - 86400 * 3, "price": 72000.0},
               "1D": {"trend": "LONG", "since": 0.0, "price": 0.0}}
TREND_STRENGTH = {"15m": 86.6, "1H": 12.0, "4H": -3.5}
STATE = {"tickers": json.loads(json.dumps(TICKERS)), "rest": json.loads(json.dumps(REST_SEED)), "trend_raw": TREND_RAW}


def bars_for(sym, tf, limit):
    spec = STATE["rest"].get(sym)
    if not spec or spec["mode"] == "none":
        return None
    if spec["mode"] == "raise":
        raise RuntimeError(f"REST boom {sym}")
    if spec["mode"] == "empty":
        return []
    gtf = {"1h": "1h", "4h": "4h", "15m": "15m", "1d": "1d"}.get(str(tf).lower())
    if not gtf:
        return None
    n = spec.get("n", limit) if spec["mode"] == "short" else limit
    return frame_bars({"golden": f"{sym}_{gtf}", "cut_ms": spec.get("cut_ms"), "n": min(n, limit)})


class FakeFetcher:
    async def get_candles(self, symbol, tf, limit=300):
        return to_df(bars_for(symbol, tf, limit))

    async def get_24h_change(self, symbol):
        t = STATE["tickers"].get(symbol)
        if not t or t["mode"] == "none":
            return None
        if t["mode"] == "raise":
            raise asyncio.TimeoutError()
        if t["mode"] == "empty":
            return {}
        last = t["last"]
        if isinstance(last, float) and t.get("drift"):
            last = last + t["drift"] * (CLOCK[0] - NOW)
        return {"last": last, "change_pct": t["change_pct"]}


class FakeScanner:
    fetcher = FakeFetcher()

    def get_trend(self):
        if STATE["trend_raw"] == "raise":
            raise RuntimeError("trend boom")
        return STATE["trend_raw"]


class FakeMsg:
    message_id = 777


class FakeBot:
    def __init__(self):
        self.calls = []

    async def send_photo(self, chat_id, photo, **kw):
        self.calls.append(["send_photo", chat_id])
        return FakeMsg()

    async def send_message(self, chat_id, text, **kw):
        self.calls.append(["send_message", chat_id])
        return FakeMsg()


BOT_OBJ = FakeBot()

# ── captures: what the renderer / share card got ────────────────────────────
RENDERS: list = []
SHARES: list = []
_orig_render = cr.render_signal_chart


def site_chart(df, kw):
    """What the site's chartPayload must answer for the renderer's inputs: render_signal_chart's own
    data steps (chart_renderer.py 828–915), read afresh from the renderer, without the drawing."""
    if df is None or len(df) < 10:
        return None
    feats = cr._features_for_tier(kw.get("tier", "pro"))
    direction = (kw.get("direction") or "LONG").upper()
    strategy = (kw.get("strategy") or "").upper()
    event, hit_levels, be_price = kw.get("event", ""), kw.get("hit_levels"), kw.get("be_price")
    progress = bool(event or hit_levels or (be_price and be_price > 0))
    entry, sl = float(kw.get("entry") or 0), float(kw.get("sl") or 0)
    tp1, tp2, tp3 = float(kw.get("tp1") or 0), float(kw.get("tp2") or 0), float(kw.get("tp3") or 0)
    for col in ("open", "high", "low", "close"):
        if col not in df.columns:
            return None
    times_full = cr._extract_times(df)
    n_bars = feats["bars"]
    pos_full = None
    entry_time = kw.get("entry_time")
    if progress and entry_time is not None and times_full is not None:
        try:
            et = pd.Timestamp(entry_time)
            pos = int(times_full.searchsorted(et, side="right")) - 1
            pos_full = max(0, min(pos, len(df) - 1))
            n_bars = min(200, max(n_bars, len(df) - pos_full + 15))
        except (ValueError, TypeError):
            pass
    start = max(0, len(df) - n_bars)
    win = df.iloc[start:].reset_index(drop=True).apply(pd.to_numeric, errors="coerce").ffill().bfill()
    times = times_full[start:] if times_full is not None else None
    n = len(win)
    last_close = float(win["close"].iloc[-1])
    if last_close > 0 and entry > 0 and max(entry, last_close) / min(entry, last_close) > 5.0:
        return None
    if entry <= 0:
        entry = last_close
    tf = cr._tf_label(cr._bar_seconds(times)) or (kw.get("timeframe") or "")
    emas = []
    if feats["ema"]:
        periods = (kw.get("extra_signal_data") or {}).get("ema_periods") or (
            ("S10", "S20", "S50", "E200") if strategy == "VOLUME" else (20, 50, 200))
        for label, ser in cr._calc_emas(pd.to_numeric(df["close"], errors="coerce"), periods):
            kind, p = label.split(" ")
            emas.append({"name": p, "label": label, "kind": kind, "period": int(p),
                         "values": [None if v != v else float(v) for v in ser.to_numpy(dtype=float)[start:]]})
    tps = [("TP1", tp1), ("TP2", tp2), ("TP3", tp3)]
    is_long = direction != "SHORT"
    hits = {h.upper() for h in (hit_levels or [])}
    if progress:
        if pos_full is not None:
            entry_idx = max(0, pos_full - start)
        else:
            hp = [(p, is_long) for nm, p in tps if p > 0 and nm in hits]
            if sl > 0 and "SL" in hits:
                hp.append((sl, not is_long))
            entry_idx = cr._guess_entry_idx(win, entry, hp)
    else:
        entry_idx = n - 1
    t_ms = (df.index.asi8[start:] // 1_000_000).tolist()

    def num(v):
        v = float(v)
        return None if v != v else v
    candles = [[int(t_ms[i])] + [num(win[c].iloc[i]) for c in ("open", "high", "low", "close", "volume")] for i in range(n)]
    return {
        "timeframe": tf,
        "meta": {"symbol": cr._norm_symbol(kw.get("symbol")), "strategy": strategy, "direction": direction,
                 "quality": str(kw.get("quality") or ""), "score": float(kw.get("score") or 0)},
        "candles": candles,
        "overlays": {"entry": entry, "sl": sl, "tps": [tp1, tp2, tp3],
                     "be": float(be_price) if be_price is not None and be_price > 0 else None,
                     "ob": [], "fvg": [], "pivots": [], "hvn": [], "lvn": [], "emas": emas},
        "event": str(event or ""), "hit_levels": [str(h) for h in (hit_levels or [])],
        "entry_index": int(entry_idx), "last_close": last_close,
    }


def render_spy(df, **kw):
    png = _orig_render(df, **kw)
    RENDERS.append({"kw": {k: (v.timestamp() if isinstance(v, pd.Timestamp) else v) for k, v in kw.items()},
                    "png": bool(png), "site": site_chart(df, kw)})
    return png


cr.render_signal_chart = render_spy
_orig_share = share_card.render_share_png


def share_spy(stats, username="", days=30, lang="ru", now=None):
    SHARES.append({"stats": stats, "days": days, "lang": lang})
    return _orig_share(stats, username, days, lang, now)


share_card.render_share_png = share_spy


class LogCap(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines = []

    def emit(self, record):
        if record.levelno >= logging.INFO:
            self.lines.append(f"{record.levelname} {record.getMessage()}")


LOGS = LogCap()
for name in ("CHM.MiniApp", "CHM.ChartRenderer"):
    lg = logging.getLogger(name)
    lg.addHandler(LOGS)
    lg.setLevel(logging.DEBUG)
logging.getLogger().setLevel(logging.WARNING)


def _tg_user(request):
    v = request.headers.get("X-Test-Uid")
    if v is None:
        return None
    user = {"id": int(v), "username": f"u{v}", "first_name": "T", "language_code": "ru"}
    if not user.get("id"):          # verify_init_data's last check
        return None
    return user


api._tg_user = _tg_user


# ── raw HTTP ────────────────────────────────────────────────────────────────
async def raw_request(port, method, target, uid, body, ctype, extra=None):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    data = body if isinstance(body, bytes) else (body.encode("utf-8", "surrogatepass") if body is not None else b"")
    head = [f"{method} {target} HTTP/1.1", "Host: 127.0.0.1", "Connection: close"]
    if uid is not None:
        head.append(f"X-Test-Uid: {uid}")
    if ctype:
        head.append(f"Content-Type: {ctype}")
    for k, v in (extra or {}).items():
        head.append(f"{k}: {v}")
    if method in ("POST", "PUT", "DELETE", "PATCH") or data:
        head.append(f"Content-Length: {len(data)}")
    writer.write(("\r\n".join(head) + "\r\n\r\n").encode("latin-1"))

    async def _send():          # the body goes out while the answer is read (a server may answer before reading it)
        try:
            for i in range(0, len(data), 65536):
                writer.write(data[i:i + 65536])
                await writer.drain()
        except (ConnectionError, OSError):
            pass
    sender = asyncio.ensure_future(_send())
    raw = await asyncio.wait_for(reader.read(), 120)
    sender.cancel()
    writer.close()
    hdr, _, rest = raw.partition(b"\r\n\r\n")
    lines = hdr.decode("latin-1").split("\r\n")
    status = int(lines[0].split(" ")[1])
    headers = {}
    for ln in lines[1:]:
        k, _, v = ln.partition(":")
        headers[k.strip().lower()] = v.strip()
    if headers.get("transfer-encoding") == "chunked":
        out = b""
        while rest:
            size, _, rest = rest.partition(b"\r\n")
            n = int(size, 16)
            if n == 0:
                break
            out += rest[:n]
            rest = rest[n + 2:]
        rest = out
    return status, headers, rest


# ── snapshots ───────────────────────────────────────────────────────────────
def trade_snapshot(con, tid):
    cols = [r[1] for r in con.execute("PRAGMA table_info(trades)").fetchall() if r[1] in TRADE_KEYS]
    row = con.execute(f"SELECT {', '.join(cols)}, {', '.join(f'typeof({c})' for c in cols)} FROM trades WHERE trade_id=?",
                      (tid,)).fetchone()
    ev = con.execute("SELECT id, ts, event_type, payload_json FROM trade_events WHERE trade_id=? ORDER BY id", (tid,)).fetchall()
    fb_cols = ("id", "user_id", "trade_id", "symbol", "strategy", "direction", "entry", "sl", "tp1", "result", "pnl_pct",
               "regime", "features", "ts")
    fb = con.execute(f"SELECT {', '.join(fb_cols)}, {', '.join(f'typeof({c})' for c in fb_cols)} "
                     "FROM trade_feedback WHERE trade_id=? ORDER BY id", (tid,)).fetchall()
    out_fb = []
    for f in fb:
        rec = {c: [f[i], f[len(fb_cols) + i]] for i, c in enumerate(fb_cols)}
        # the features text byte for byte, session_hour masked (datetime.utcnow(): the wall clock, not the pinned one)
        rec["features"][0] = __import__("re").sub(r'"session_hour": \d+', '"session_hour": H', f[12])
        out_fb.append(rec)
    if not row:
        return {"row": None, "events": [list(e) for e in ev], "feedback": out_fb}
    k = len(cols)
    return {"row": {c: [row[i], row[k + i]] for i, c in enumerate(cols)}, "events": [list(e) for e in ev], "feedback": out_fb}


def kv_snapshot(con, uid):
    rows = con.execute("SELECT key, value FROM kv WHERE key LIKE ? OR key LIKE ? ORDER BY key",
                       (f"analyze_count_{uid}_%", f"miniapp_feedback_{uid}_%")).fetchall()
    return {k: v for k, v in rows}


def mem_snapshot(uid):
    return {"rate": {b: len(api._RATE.get(f"{b}:{uid}", [])) for b in ("post", "chart", "share")},
            "analyze_last": api._analyze_last.get(uid),
            "market": {"ts": api._market_cache["ts"], "coins": sorted(api._market_cache["data"].keys())}}


# ── steps ───────────────────────────────────────────────────────────────────
STEPS: list = []
T = [NOW]
B = "/miniapp/api"
J = json.dumps


def step(family, name, uid, method, path, body=None, *, ctype="application/json", dt=4.0, sets=None, trade=None,
         auth="test", sql=None, headers=None):
    T[0] += dt
    STEPS.append({"family": family, "name": name, "uid": uid, "method": method, "path": path,
                  "body": body, "ctype": ctype, "now": T[0], "set": sets or {}, "trade": trade, "auth": auth,
                  "sql": sql or [], "req_headers": headers or {}})


GET_ROUTES = ["/dashboard", "/signals", "/signals/dup/chart", "/stats"]
POST_ROUTES = ["/signals/dup/result", "/analyze", "/share", "/feedback"]

# A. auth: no / garbage credentials, uid 0
for p in GET_ROUTES:
    step("auth", f"no auth GET {p}", None, "GET", B + p)
    step("auth", f"garbage auth GET {p}", None, "GET", B + p, auth="garbage")
for p in POST_ROUTES:
    step("auth", f"no auth POST {p}", None, "POST", B + p, J({"result": "TP1", "symbol": "BTC", "type": "bug"}))
step("auth", "uid 0 dashboard", 0, "GET", B + "/dashboard")
step("auth", "uid 0 feedback", 0, "POST", B + "/feedback", J({"type": "bug", "text": "0123456789"}))
step("auth", "no auth HEAD dashboard", None, "HEAD", B + "/dashboard")

# B. routing (aiohttp's answers before the handler)
for m, p in (("POST", "/dashboard"), ("PUT", "/signals"), ("DELETE", "/stats"), ("GET", "/analyze"), ("GET", "/share"),
             ("GET", "/feedback"), ("PATCH", "/feedback"), ("GET", "/signals/dup/result"), ("POST", "/signals/dup/chart"),
             ("OPTIONS", "/signals"), ("GET", "/signals/"), ("GET", "/signals//chart"), ("GET", "/signals/dup/chart/"),
             ("GET", "/signals/dup/CHART"), ("GET", "/Signals"), ("GET", "/dashboard/"), ("GET", "/dash%62oard"),
             ("GET", "/signals%2Fdup%2Fchart"), ("GET", "/./stats"), ("GET", "/x/../stats"), ("GET", "/signals/a%7Bb/chart"),
             ("POST", "/signals/%7D/result"), ("GET", "/signals/dup/chart?x=1"), ("HEAD", "/signals"), ("HEAD", "/analyze"),
             ("GET", "/stats%3Fdays=7"), ("GET", "/signals/../dashboard"), ("POST", "/analyze/"), ("GET", "/events/x"),
             ("GET", "//signals"), ("GET", "/signals//"), ("GET", "/signals/dup//chart"), ("GET", "/signals%2F"),
             ("POST", "/signals/dup/result/"), ("GET", "/signals/%2E%2E/chart"), ("GET", "/sign%61ls/dup/ch%61rt"),
             ("GET", "/ME"), ("GET", "/me/"), ("GET", "/Help"), ("POST", "/LANG"), ("GET", "/plan/"), ("GET", "/Genome"),
             ("GET", "/challenge/"), ("GET", "/settings/ALL"), ("GET", "//me"), ("GET", "/me//")):
    step("route", f"route {m} {p}", 301, m, B + p, "{}" if m in ("POST", "PUT", "DELETE", "PATCH") else None, dt=0.5)

# B2. request headers aiohttp ignores: conditional GETs (Express' freshness check answers 304), the HTML 500 page
for nm, path, hdrs in (("If-None-Match *", "/signals?limit=2", {"If-None-Match": "*"}),
                       ("If-None-Match etag", "/stats?days=7", {"If-None-Match": 'W/"1a-abc"'}),
                       ("If-Modified-Since", "/dashboard", {"If-Modified-Since": "Thu, 01 Jan 2099 00:00:00 GMT"}),
                       ("Cache-Control no-cache + If-None-Match *", "/signals?limit=1", {"If-None-Match": "*", "Cache-Control": "no-cache"}),
                       ("Range", "/signals?limit=1", {"Range": "bytes=0-5"})):
    step("route", f"headers {nm}", 302, "GET", B + path, dt=0.5, headers=hdrs)
step("route", "headers HEAD If-None-Match *", 302, "HEAD", B + "/signals?limit=1", dt=0.5, headers={"If-None-Match": "*"})
step("route", "headers 500 page as HTML", 344, "GET", B + "/signals", dt=0.5, headers={"Accept": "text/html,application/xhtml+xml"})
step("route", "headers 500 page as plain text", 344, "GET", B + "/signals", dt=0.5, headers={"Accept": "application/json"})
step("route", "headers 404 with Accept html", 302, "GET", B + "/nope", dt=0.5, headers={"Accept": "text/html"})

# C. dashboard — every user, market cache / tickers / trend / trend monitor / rating cache states
step("dashboard", "dashboard 301 first", 301, "GET", B + "/dashboard",
     sets={"trend_state": TREND_STATE, "trend_strength": TREND_STRENGTH})
step("dashboard", "dashboard 302 market cached", 302, "GET", B + "/dashboard", dt=30)
step("dashboard", "dashboard 303 market expired, ETH empty dict", 303, "GET", B + "/dashboard", dt=31,
     sets={"tickers": {"ETH-USDT-SWAP": {"mode": "empty"}}})
step("dashboard", "dashboard 304 tickers as strings / bool", 304, "GET", B + "/dashboard", dt=61,
     sets={"tickers": {"BTC-USDT-SWAP": {"mode": "ok", "last": " 73000.5 ", "change_pct": "1_2.345", "drift": 0},
                       "ETH-USDT-SWAP": {"mode": "ok", "last": True, "change_pct": None, "drift": 0}}})
step("dashboard", "dashboard 305 BTC 'abc' last (coin skipped), ETH raises", 305, "GET", B + "/dashboard", dt=61,
     sets={"tickers": {"BTC-USDT-SWAP": {"mode": "ok", "last": "abc", "change_pct": 1, "drift": 0},
                       "ETH-USDT-SWAP": {"mode": "raise"}}})
step("dashboard", "dashboard 306 both none: empty is not cached", 306, "GET", B + "/dashboard", dt=1,
     sets={"tickers": {"BTC-USDT-SWAP": {"mode": "none"}, "ETH-USDT-SWAP": {"mode": "none"}}})
step("dashboard", "dashboard 307 inf / nan change", 307, "GET", B + "/dashboard", dt=2,
     sets={"tickers": {"BTC-USDT-SWAP": {"mode": "ok", "last": 1e308, "change_pct": "inf", "drift": 0},
                       "ETH-USDT-SWAP": {"mode": "ok", "last": -0.0, "change_pct": "-nan", "drift": 0}},
           "trend_raw": {"BTC": {"trend_text": 5}, "ETH": {"trend_text": ["H1: 🟢"]}}})
step("dashboard", "dashboard 308 trend raises", 308, "GET", B + "/dashboard", dt=61,
     sets={"tickers": {"BTC-USDT-SWAP": {"mode": "ok", "last": 73458.52026, "change_pct": 0.005, "drift": 0.5},
                       "ETH-USDT-SWAP": {"mode": "ok", "last": 5245.660744, "change_pct": -2.675, "drift": 0}},
           "trend_raw": "raise"})
step("dashboard", "dashboard 309 trend ok again, strength nan", 309, "GET", B + "/dashboard", dt=3,
     sets={"trend_raw": TREND_RAW, "trend_state": TREND_STATE, "trend_strength": {"15m": float("nan"), "1H": 3.0}})
step("dashboard", "dashboard 310 strength inf", 310, "GET", B + "/dashboard", dt=3,
     sets={"trend_state": TREND_STATE, "trend_strength": {"15m": float("inf")}})
step("dashboard", "dashboard 311 trend state reset", 311, "GET", B + "/dashboard", dt=3,
     sets={"trend_state": TREND_STATE, "trend_strength": TREND_STRENGTH,
           "trend_raw": {"BTC": None, "ETH": {"trend_text": "H1: 🟢 : 🔴"}}})
for uid in [u for u in UIDS if u not in (301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311)] + [FRESH_UID]:
    step("dashboard", f"dashboard {uid}", uid, "GET", B + "/dashboard", dt=7, sets={"trend_raw": TREND_RAW} if uid == 312 else None)
step("dashboard", "dashboard 301 rating cache expired (15 min)", 301, "GET", B + "/dashboard", dt=901)
step("dashboard", "HEAD dashboard 316", 316, "HEAD", B + "/dashboard", dt=2)

# D. signals — query variants on a rich user, then every user
SIGQ = ["", "?status=open", "?status=closed", "?status=all&limit=5", "?limit=200", "?limit=201", "?limit=0", "?limit=-0",
        "?limit=+0", "?limit=-5", "?limit=1e3", "?limit=1.0", "?limit=%D9%A3", "?limit=1_0", "?limit=_10", "?limit=0x10",
        "?limit=%205", "?limit=5%20", "?limit=%2B5", "?limit=" + "9" * 20, "?limit=" + "9" * 4301, "?limit=", "?limit",
        "?limit=%00", "?limit=%E2%80%835", "?status=OPEN", "?status=%6Fpen", "?status=open&status=closed",
        "?status=closed&limit=3", "?strategy=levels", "?strategy=Smc&status=open", "?strategy=VOLUME&status=closed&limit=4",
        "?strategy=gerchik", "?strategy=ALL", "?strategy=%C5%BFmc", "?strategy=levels%00", "?strategy[]=SMC",
        "?strategy=levels&strategy=smc", "?strategy=", "?;status=open", "?status=%zz", "?&&status=closed&&",
        "?status=open#frag", "?strategy=%ed%a0%80", "?limit=6&status=closed&strategy=SMC", "?STATUS=open", "?limit=3;x=1"]
for q in SIGQ:
    step("signals", f"signals 301 {q[:48]}", 301, "GET", B + "/signals" + q, dt=1)
for uid in UIDS + [FRESH_UID]:
    step("signals", f"signals {uid}", uid, "GET", B + "/signals", dt=1.5)
    if uid in (302, 316, 320, 333, 340, 341, 343, 344):
        step("signals", f"signals {uid} closed 200", uid, "GET", B + "/signals?status=closed&limit=200", dt=1.5)

# E. stats — query variants, then every user
STATQ = ["", "?days=7", "?days=1", "?days=0", "?days=-3", "?days=365", "?days=366", "?days=400", "?days=abc", "?days=%2030",
         "?days=1e2", "?days=" + "1" * 4400, "?days=7.0", "?days=%D9%A3%D9%A0", "?days=", "?days=7&days=abc", "?days=+14",
         "?days=99999999999999999999", "?strategy=SMC", "?strategy=levels&tf=1h", "?tf=1H", "?tf=4h&days=60",
         "?tf=15m&strategy=VOLUME", "?tf=junk", "?tf=60", "?tf=%C4%B0", "?strategy=junk&tf=", "?tf=%201h", "?tf=1h%20",
         "?strategy=gerchik", "?strategy=%C5%BFmc&tf=4H", "?days=90&tf=30m", "?days=365&tf=1d"]
for q in STATQ:
    step("stats", f"stats 301 {q[:48]}", 301, "GET", B + "/stats" + q, dt=1)
for uid in UIDS + [FRESH_UID]:
    step("stats", f"stats {uid} 365", uid, "GET", B + "/stats?days=365", dt=1.5)
    if uid in (302, 316, 320, 333):
        step("stats", f"stats {uid} 30", uid, "GET", B + "/stats", dt=1.5)

# F. chart — owner checks, hostile ids, statuses, sources, timestamps; the 10 / 60 s bucket
CHART_IDS = ["dup", "DUP", "dup%20", "0", "%30", "-1", "1e3", "01", "1", "1000", "99999999999999999999", "%00", "a%2Fb",
             "a%2fb", "%2541", "%41", "%D1%82%D0%B5%D1%81%D1%82", "%F0%9F%98%80", "%ff", "nope", "x" * 300]
for i, tid in enumerate(CHART_IDS):
    step("chart", f"chart 301 {tid[:24]}", 301, "GET", B + f"/signals/{tid}/chart", dt=7)
for tid in ("c-future", "c-2100", "c-neg", "c-1970", "c-zero", "c-null", "c-30m", "c-60", "c-1d", "c-short", "c-nan",
            "c-pmult", "c-expired", "c-vol", "c-uni", "c-302"):
    step("chart", f"chart 301 {tid}", 301, "GET", B + f"/signals/{tid}/chart", dt=7)
for r in [t for t in trades if t["user_id"] in (302, 316, 320, 333) and t["trade_id"].startswith("d")][:48]:
    step("chart", f"chart {r['trade_id']} u{r['user_id']}", r["user_id"], "GET", B + f"/signals/{r['trade_id']}/chart", dt=7)
for k in range(12):
    step("chart", f"chart burst 324 #{k}", 324, "GET", B + "/signals/nope/chart", dt=0.25)
step("chart", "chart 324 window edge (60 s after the 1st hit)", 324, "GET", B + "/signals/nope/chart", dt=60.0 - 11 * 0.25)
step("chart", "chart 302 → 301's trade 404", 302, "GET", B + "/signals/dup/chart", dt=1)
step("chart", "chart REST short", 301, "GET", B + "/signals/c-30m/chart", dt=1, sets={"rest": {"BTC-USDT-SWAP": {"mode": "short", "n": 29}}})
step("chart", "chart BTC REST raises (cache 1H ok)", 301, "GET", B + "/signals/dup/chart", dt=1, sets={"rest": {"BTC-USDT-SWAP": {"mode": "raise"}}})
step("chart", "chart BTC REST empty, 4H row", 301, "GET", B + "/signals/1000/chart", dt=1, sets={"rest": {"BTC-USDT-SWAP": {"mode": "empty"}}})
step("chart", "chart BTC REST back", 301, "GET", B + "/signals/c-1d/chart", dt=1, sets={"rest": {"BTC-USDT-SWAP": {"mode": "ok"}}})
step("chart", "chart HEAD", 301, "HEAD", B + "/signals/dup/chart", dt=1)
step("chart", "chart c-future by its owner (year 5138: searchsorted overflows → no entry bar)", 346, "GET", B + "/signals/c-future/chart", dt=7)
step("chart", "chart p-y10k by its owner (year 10000)", 343, "GET", B + "/signals/p-y10k/chart", dt=7)
step("chart", "chart p-ok2 by its owner", 343, "GET", B + "/signals/p-ok2/chart", dt=7)

# G. manual result
RES = [
    ("dup", J({"result": " tp1 "})), ("dup", J({"result": "TP2"})), ("DUP", J({"result": "TP2"})),
    ("dup%20", J({"result": "SL"})), ("0", J({"result": "ſl"})), ("-1", J({"result": "BE", "note": "  взял руками  "})),
    ("1e3", J({"result": "SKIP"})), ("1e3", J({"result": "TP1"})), ("01", J({"result": "TP3"})), ("%30", J({"note": "id via %30"})),
    ("1000", J({"result": "be"})), ("99999999999999999999", J({"note": "x" * 500})), ("%00", J({"result": "TP2"})),
    ("a%2Fb", J({"note": "slash"})), ("%2541", J({"result": "TP1"})), ("%41", J({"result": "SL"})),
    ("%D1%82%D0%B5%D1%81%D1%82", J({"result": "TP1"})), ("%F0%9F%98%80", J({"result": "SKIP", "note": None})),
    ("r-null", J({"result": "TP1"})), ("r-null", J({"note": "on a NULL result"})), ("r-skip", J({"result": "TP2"})),
    ("r-exch", J({"result": "SL"})), ("r-exch", J({"note": "exchange note"})), ("r-done", J({"result": "SL"})),
    ("r-done", J({"result": "SKIP"})), ("r-orphan", J({"result": "TP1"})), ("r-lower", J({"result": "TP1"})),
    ("r-nostop", J({"result": "TP2"})), ("r-osl0", J({"result": "TP3"})), ("r-texte", J({"result": "TP1"})),
    ("r-huge", J({"result": "TP1"})), ("r-tpl", J({"result": "SKIP"})), ("r-302", J({"result": "TP1"})),
    ("r-note", "not json"), ("r-note", J({})), ("r-note", "[1, 2]"), ("r-note", J({"result": "tp4"})), ("r-note", J({"result": 0})),
    ("r-note", J({"result": 1})), ("r-note", J({"result": True})), ("r-note", J({"result": []})), ("r-note", J({"result": [], "note": "x"})),
    ("r-note", J({"note": None})), ("r-note", J({"note": 5})), ("r-note", J({"note": False})), ("r-note", J({"note": ["a"]})),
    ("r-note", J({"note": "я" * 500})), ("r-note", J({"note": "я" * 501})), ("r-note", J({"note": "😀" * 500})),
    ("r-note", J({"note": "😀" * 501})), ("r-note", J({"note": ""})), ("r-note", J({"note": " \u2003trim\u2003 "})),
    ("r-note", '{"note": "a", "note": "dup-key"}'), ("r-note", '{"result": NaN}'), ("r-note", '{"result": 1e400}'),
    ("r-sur", '{"note": "lone \\ud800 surrogate"}'), ("r-sur", '{"note": "pair \\ud83d\\ude00 ok"}'),
    ("r-sur", '{"result": "\\ud800"}'), ("nope", J({"result": "TP1"})), ("r-inf", J({"result": "TP1"})),
    ("r-inf", J({"note": "after inf"})), ("r-nan", J({"result": "TP1"})), ("r-q", J({"result": "SL"})), ("r-q", J({"result": "TP1"})),
]
for tid, body in RES:
    import urllib.parse as _up
    owner = {"DUP": 302, "dup%20": 303, "-1": 302, "r-302": 302, "r-texte": 345, "r-q": 347}.get(tid, 301)
    real = _up.unquote(tid) if tid not in ("%2541",) else "%41"
    step("result", f"result {tid[:20]} {body[:44]}", owner, "POST", B + f"/signals/{tid}/result", body, dt=3, trade=real)
step("result", "result 302 → 301's trade", 302, "POST", B + "/signals/dup/result", J({"result": "SL"}), dt=3, trade="dup")
step("result", "result -7 own", -7, "POST", B + "/signals/r-neg/result", J({"result": "TP1"}), dt=3, trade="r-neg")
step("result", "result 7000000001 own", 7000000001, "POST", B + "/signals/r-big/result", J({"result": "SL", "note": "big"}), dt=3, trade="r-big")
step("result", "result latin-1 charset note", 301, "POST", B + "/signals/r-note/result", '{"note": "café"}'.encode("latin-1"),
     ctype="application/json; charset=latin-1", dt=3, trade="r-note")
step("result", "result utf-8-sig BOM", 301, "POST", B + "/signals/r-note/result", b"\xef\xbb\xbf" + J({"note": "bom"}).encode(),
     ctype="application/json; charset=utf-8-sig", dt=3, trade="r-note")
step("result", "signals 301 after results", 301, "GET", B + "/signals?limit=200", dt=2)
step("result", "stats 301 after results", 301, "GET", B + "/stats?days=365", dt=2)

# H. analyze — plans, quotas, cooldown, symbols, strategies, fetch / price modes
AN = [
    (301, J({"symbol": "syndn03", "strategy": "auto"})), (301, J({"symbol": "BTC/USDT", "strategy": "SMC"})),
    (301, J({"symbol": "SYNLV05USDT", "strategy": "levels"})), (301, J({"symbol": "synrg02", "strategy": "VOLUME"})),
    (301, J({"symbol": "SYNUP03", "strategy": "junk"})), (301, J({"symbol": "SYNDN04"})), (301, J({"symbol": "SYNLV06"})),
    (301, J({"symbol": "NOPE1", "strategy": "AUTO"})), (301, J({"symbol": "SYNVL05"})), (301, J({"symbol": "SYNVL06"})),
    (302, J({"symbol": "ETH"})), (302, J({"symbol": "ETH"})),
    (303, J({"symbol": "BTC"})), (304, J({"symbol": "BTC"})), (305, J({"symbol": "SYNDN01"})), (306, J({"symbol": "SYNDN02"})),
    (307, J({"symbol": "SYNLV01"})), (308, J({"symbol": "BTC"})), (309, J({"symbol": "SYNLV02"})), (309, J({"symbol": "SYNLV02"})),
    (310, J({"symbol": "BTC"})), (311, J({"symbol": "SYNUP01"})), (311, J({"symbol": "SYNUP01"})), (312, J({"symbol": "BTC"})),
    (313, J({"symbol": "SYNDN05"})), (313, J({"symbol": "SYNDN06"})), (314, J({"symbol": "BTC"})), (315, J({"symbol": "BTC"})),
    (317, J({"symbol": "SYNLV03"})), (319, J({"symbol": "SYNLV04"})), (123, J({"symbol": "SYNLV07"})), (123, J({"symbol": "SYNLV08"})),
    (-7, J({"symbol": "SYNDN07"})), (FRESH_UID, J({"symbol": "SYNDN08"})), (FRESH_UID, J({"symbol": "SYNDN08"})),
    (316, J({"symbol": ""})), (316, J({"symbol": "X"})), (316, J({"symbol": "a<b"})), (316, J({"symbol": 123})),
    (316, J({"symbol": 10.0})), (316, '{"symbol": 1e14}'), (316, J({"symbol": ["BTC"]})), (316, J({"symbol": "ABCDEFGHIJKLMNOP"})),
    (316, J({})), (316, "garbage"), (316, J({"symbol": "  btc "})), (316, J({"symbol": "1000PEPE", "strategy": 5})),
    (316, J({"symbol": "ßTC"})), (316, J({"symbol": "ınj"})), (316, J({"symbol": "BTC\n"})), (316, J({"symbol": None})),
    (316, J({"symbol": True})), (316, '{"symbol": "\\ud800"}'), (316, J({"symbol": "USDT"})), (316, J({"symbol": "BTCUSDTUSDT"})),
    (316, J({"symbol": "BTC", "strategy": None})), (316, J({"symbol": "ETH", "strategy": ["SMC"]})),
]
for uid, body in AN:
    step("analyze", f"analyze {uid} {body[:44]}", uid, "POST", B + "/analyze", body, dt=11 if uid not in (302, 309, 311) else 4)

# I. share — days matrix, limiter (3 / 600 s), no_data, poison
SH = [
    (301, None), (302, J({"days": 1})), (305, J({"days": 400})), (306, J({"days": "45"})), (307, J({"days": "4.5"})),
    (308, J({"days": None})), (313, J({"days": []})), (123, J({"days": True})), (303, '{"days": 1e400}'),
    (304, '{"days": ' + "1" + "0" * 400 + "}"), (309, '{"days": NaN}'), (310, J({"days": " 20 "})), (311, J({"days": 7.9})),
    (321, J({})), (312, J({"days": 7})), (314, J({"days": -5})), (315, J({"days": {"a": 1}})), (316, J({"days": "٣٠"})),
    (318, J({"days": "1_4"})), (320, J({"days": -1e400})), (322, '{"days": -' + "9" * 30 + "}"),
    (340, J({})), (341, J({})), (342, J({"days": 30})), (343, J({"days": 365})), (344, J({})), (FRESH_UID, J({})),
    (301, J({"days": 60})), (301, J({"days": 90})), (301, J({"days": 14})),
]
for uid, body in SH:
    step("share", f"share {uid} {str(body)[:30]}", uid, "POST", B + "/share", body if body is not None else "", dt=2,
         ctype="application/json" if body is not None else None)
step("share", "share 301 after 10 min", 301, "POST", B + "/share", J({}), dt=601)

# J. feedback — types, texts, counters, surrogates, sizes, day rollover
FB = [
    (302, J({"type": "bug", "text": "Не работает кнопка на графике"})), (302, J({"type": " Idea ", "text": "  Хочу тёмную тему!  "})),
    (302, J({"type": "OTHER", "text": "x" * 10})), (302, J({"type": "feature", "text": "valid text here"})),
    (302, J({"type": None, "text": "valid text here"})), (302, J({"text": "valid text here"})), (302, J({"type": "constructor", "text": "proto key"})),
    (318, J({"type": "bug", "text": "x" * 9})), (318, J({"type": "bug", "text": "   short   "})),
    (318, J({"type": "bug", "text": "x" * 2000})), (318, J({"type": "bug", "text": "x" * 2001})),
    (318, J({"type": "bug", "text": [1, 2, 3, 4, 5]})), (318, J({"type": "bug", "text": 1234567890})),
    (320, '{"type": "bug", "text": 12345678.0}'), (320, J({"type": "bug", "text": {"a": "bbbbbbbbbb"}})),
    (320, J({"type": "bug", "text": True})), (320, '{"type": "bug", "text": 1e100}'),
    (303, J({"type": "bug", "text": "sixth today, limited"})), (304, J({"type": "idea", "text": "INT64 max counter"})),
    (305, J({"type": "other", "text": "x counter value"})), (306, J({"type": "other", "text": "4.9 counter value"})),
    (306, J({"type": "other", "text": "4.9 counter, 6th"})), (307, J({"type": "bug", "text": "negative counter"})),
    (308, J({"type": "bug", "text": "padded counter"})), (308, J({"type": "bug", "text": "padded counter 6"})),
    (309, J({"type": "bug", "text": "yesterday at five"})), (316, J({"type": "bug", "text": "😀" * 10})),
    (316, J({"type": "bug", "text": "😀" * 2001})), (316, '{"type": "bug", "text": "\\ud83d\\ude00 lone \\ud800 surrogate"}'),
    (316, '{"type": "bug", "text": "two \\udc00\\udc01 lone"}'), (316, J({"type": ["bug"], "text": "list type value"})),
    (316, J({"type": "bug", "text": "\u2003\u2003ten chars!\u2003"})), (FRESH_UID, J({"type": "idea", "text": "fresh user idea"})),
    (-7, J({"type": "bug", "text": "negative uid feedback"})), (7000000001, J({"type": "bug", "text": "big uid feedback"})),
    (331, J({"type": "\u0130DEA", "text": "dotted capital I"})), (331, J({"type": "idea\u0000", "text": "nul in the type"})),
    (331, J({"type": "\u00a0bug\u3000", "text": "nbsp / ideographic space around the type"})), (331, J({"type": 5, "text": "int type value"})),
    (334, '{"type": "bug", "text": "café latin"}'.encode("latin-1")),
]
for uid, body in FB:
    ct = "application/json; charset=iso-8859-1" if isinstance(body, bytes) else "application/json"
    step("feedback", f"feedback {uid} {str(body)[:44]}", uid, "POST", B + "/feedback", body, dt=2, ctype=ct)
step("feedback", "feedback 303 next day", 303, "POST", B + "/feedback", J({"type": "bug", "text": "a new day, new quota"}), dt=86400)

# K. bodies over aiohttp's 1 MiB client_max_size, exactly at it (a spec {head, pad, n, tail}: built on both sides)
def big(head, pad, total, tail):
    return {"head": head, "pad": pad, "n": total - len(head.encode()) - len(tail.encode()), "tail": tail}


step("body", "feedback body exactly 1 MiB", 325, "POST", B + "/feedback", big('{"type": "bug", "text": "exactly one MiB"', " ", 1048576, "}"), dt=2)
step("body", "feedback body 1 MiB + 1", 325, "POST", B + "/feedback", big('{"type": "bug", "text": "one byte over the cap"', " ", 1048577, "}"), dt=2)
step("body", "result body 1 MiB + 1", 301, "POST", B + "/signals/r-note/result", big('{"note": "', "y", 1048577, '"}'), dt=2, trade="r-note")
step("body", "analyze body 2 MiB", 327, "POST", B + "/analyze", big('{"symbol": "BTC", "pad": "', "z", 2097152, '"}'), dt=2)
step("body", "GET with a 2 MiB body", 327, "GET", B + "/signals?limit=1", big("", "q", 2097152, ""), dt=2)
step("body", "unauth POST with a 2 MiB body", None, "POST", B + "/feedback", big("", "q", 2097152, ""), dt=2)
step("body", "unknown charset", 325, "POST", B + "/feedback", J({"type": "bug", "text": "unknown charset body"}),
     ctype="application/json; charset=x-unknown", dt=2)

# L. the generic POST bucket: 30 / 60 s per user → 429 (Retry-After 10) for every POST route
for k in range(29):
    step("postbucket", f"postbucket 330 #{k}", 330, "POST", B + "/feedback", J({"type": "nope"}), dt=0.5)
step("postbucket", "postbucket 330 GET (not counted)", 330, "GET", B + "/signals?limit=1", dt=0.5)
step("postbucket", "postbucket 330 #30 share", 330, "POST", B + "/share", J({}), dt=0.5)
step("postbucket", "postbucket 330 #31 analyze → 429", 330, "POST", B + "/analyze", J({"symbol": "BTC"}), dt=0.5)
step("postbucket", "postbucket 330 #32 result → 429", 330, "POST", B + "/signals/dup/result", J({"result": "TP1"}), dt=0.5)
step("postbucket", "postbucket 330 #33 feedback → 429", 330, "POST", B + "/feedback", J({"type": "bug", "text": "0123456789"}), dt=0.5)
step("postbucket", "postbucket 330 unauth-routed 405 not counted", 330, "POST", B + "/dashboard", "{}", dt=0.5)
step("postbucket", "postbucket 330 after window", 330, "POST", B + "/share", J({}), dt=60.0)


# M. poison rows (inf / TEXT created_at): every reader of them, the all-users rating included
def _ins(r):
    return ["INSERT INTO {T} (" + ", ".join(TRADE_KEYS) + ") VALUES (" + ", ".join("?" * len(TRADE_KEYS)) + ")",
            [r.get(c) for c in TRADE_KEYS]]


step("poison", "poison in; dashboard 340 (rating recomputed after 15 min)", 340, "GET", B + "/dashboard", dt=901,
     sql=[_ins(P_INF), _ins(P_ABC)])
step("poison", "dashboard 302 rating error is not cached", 302, "GET", B + "/dashboard", dt=5)
step("poison", "dashboard 341", 341, "GET", B + "/dashboard", dt=5)
for uid in (340, 341):
    step("poison", f"signals {uid}", uid, "GET", B + "/signals", dt=2)
    step("poison", f"signals {uid} closed", uid, "GET", B + "/signals?status=closed", dt=2)
    step("poison", f"stats {uid}", uid, "GET", B + "/stats", dt=2)
    step("poison", f"share {uid}", uid, "POST", B + "/share", J({}), dt=2)
step("poison", "chart p-inf", 340, "GET", B + "/signals/p-inf/chart", dt=2)
step("poison", "chart p-abc", 341, "GET", B + "/signals/p-abc/chart", dt=2)
step("poison", "result p-inf", 340, "POST", B + "/signals/p-inf/result", J({"result": "SL"}), dt=2, trade="p-inf")
step("poison", "result p-abc note then 500", 341, "POST", B + "/signals/p-abc/result", J({"note": "written before the 500"}), dt=2, trade="p-abc")
step("poison", "result p-abc result then 500", 341, "POST", B + "/signals/p-abc/result", J({"result": "TP1"}), dt=2, trade="p-abc")
step("poison", "poison out; dashboard 303 rating back", 303, "GET", B + "/dashboard", dt=5,
     sql=[["DELETE FROM {T} WHERE trade_id IN ('p-inf', 'p-abc')", []]])


# ── unit vectors (json.dumps of awkward floats / strings, the way web.json_response writes them) ──
def unit_vectors():
    floats = [0.0, -0.0, 1.0, 2.0, 1e16, 1e-5, 1e-7, 1.5e300, 1e308, 5e-324, 2.675, 0.1 + 0.2, 123456789.125, 1e22, 1e21,
              9007199254740993.0, 73458.52026, -1e-300, float("inf"), float("-inf"), float("nan"), 100.0, 1234567890123456.7]
    strs = ["", "plain", "кириллица", "😀", "a\"b\\c", "\u0000\u001f\u007f\u0080", "\u2028\u2029", "\ud800", "\udfff\ud800", "é" * 3]
    return {"floats": [[f, json.dumps(f)] for f in floats],
            "strings": [[s, json.dumps(s)] for s in strs],
            "dicts": [[{"60": 1, "1": 2, "a": 3, "__proto__": 4, "constructor": 5}, json.dumps({"60": 1, "1": 2, "a": 3, "__proto__": 4, "constructor": 5})]]}


# ── run ─────────────────────────────────────────────────────────────────────
def apply_sql(con, stmts):
    for sql, params in stmts:
        con.execute(sql.replace("{T}", "trades"), params)
    con.commit()


async def main():
    await database.init_db(DBP)
    con = sqlite3.connect(DBP)
    for uid, plan, status, exp, lang, strat, _admin in USERS:
        con.execute("INSERT OR REPLACE INTO users (user_id, username, sub_plan, sub_status, sub_expires, lang, strategy) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (uid, f"u{uid}", plan, status, None if exp is None else (NOW + exp if exp else 0), lang, strat))
    cols = TRADE_KEYS
    for r in trades:
        con.execute(f"INSERT INTO trades ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", [r.get(c) for c in cols])
    for e in EVENTS:
        con.execute("INSERT INTO trade_events (id, trade_id, ts, event_type, payload_json) VALUES (?, ?, ?, ?, ?)",
                    (e["id"], e["trade_id"], e["ts"], e["event_type"], e["payload_json"]))
    for k, v in KV.items():
        con.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", (k, v))
    for fid, uid, typ, text in FEEDBACK_SEED:
        con.execute("INSERT INTO feedback (id, user_id, username, type, text, status, created_at, updated_at) "
                    "VALUES (?, ?, '', ?, ?, 'new', ?, ?)", (fid, uid, typ, text, NOW - DAY, NOW - DAY))
    con.commit()
    seeded_types = {r[0]: list(r[1:]) for r in con.execute(
        f"SELECT trade_id, {', '.join(f'typeof({c})' for c in cols)} FROM trades").fetchall()}
    cache.init_cache(4000)
    for c in CACHE_SEED:
        await cache.set_candles(c["symbol"], c["tf"], to_df(frame_bars(c)), {c["tf"]: 10 * 86400})
    app = web.Application()
    api.register(app, bot=BOT_OBJ, um=UserManager(), scanner=FakeScanner())
    server = TestServer(app)
    await server.start_server()
    port = server.port
    out = []
    for i_step, s in enumerate(STEPS):
        print(f"[{i_step + 1}/{len(STEPS)}] {s['name'][:70]}", file=sys.stderr, flush=True)
        CLOCK[0] = s["now"]
        st = s["set"]
        if "tickers" in st:
            STATE["tickers"].update(json.loads(json.dumps(st["tickers"])))
        if "rest" in st:
            STATE["rest"].update(st["rest"])
        if "trend_raw" in st:
            STATE["trend_raw"] = st["trend_raw"]
        if "trend_state" in st:
            tm._state.clear()
            tm._state.update(json.loads(json.dumps(st["trend_state"])))
            tm._strength.clear()
            tm._strength.update(st.get("trend_strength") or {})
        if s["sql"]:
            apply_sql(con, s["sql"])
        RENDERS.clear()
        SHARES.clear()
        LOGS.lines.clear()
        BOT_OBJ.calls.clear()
        uid_hdr = s["uid"] if s["auth"] == "test" else None
        payload = s["body"]
        if isinstance(payload, dict):
            payload = (payload["head"] + payload["pad"] * payload["n"] + payload["tail"]).encode()
        status, headers, raw = await raw_request(port, s["method"], s["path"], uid_hdr, payload, s["ctype"], s["req_headers"])
        for _ in range(4):
            await asyncio.sleep(0.01)          # emit_bg trade_events / admin-card tasks
        text = raw.decode("utf-8", "replace")
        expect = None
        mismatch = []
        is_json = headers.get("content-type", "").startswith("application/json")
        doc = json.loads(text) if is_json and status == 200 and s["method"] != "HEAD" else None
        fam = s["family"]
        route_path = __import__("urllib.parse").parse.unquote(s["path"].split("?", 1)[0])
        if isinstance(doc, dict) and doc.get("ok") and route_path.endswith("/chart"):
            if len(RENDERS) != 1 or RENDERS[0]["site"] is None:
                mismatch.append(f"chart ok but site payload missing ({len(RENDERS)} renders)")
            else:
                expect = json.dumps({"ok": True, "png": None, **RENDERS[0]["site"]})
        elif isinstance(doc, dict) and doc.get("ok") and route_path.endswith("/analyze"):
            body = dict(doc)
            if body.get("png") is not None:
                if len(RENDERS) != 1 or RENDERS[0]["site"] is None:
                    mismatch.append("analyze png but site payload missing")
                else:
                    body["png"] = None
                    body.update(RENDERS[0]["site"])
            elif RENDERS and RENDERS[0]["site"] is not None:
                mismatch.append("analyze: renderer None but site payload present")
            expect = json.dumps(body)
        elif isinstance(doc, dict) and doc.get("ok") and route_path.endswith("/share"):
            if len(SHARES) != 1:
                mismatch.append("share ok without a captured card")
            else:
                expect = json.dumps({"ok": True, "sent": False, "days": SHARES[0]["days"], "stats": SHARES[0]["stats"]})
        for rr in RENDERS:
            if bool(rr["site"]) != rr["png"]:
                mismatch.append(f"renderer png={rr['png']} vs site payload={'yes' if rr['site'] else 'None'}")
        con2 = sqlite3.connect(DBP)
        rec = {k: s[k] for k in ("family", "name", "uid", "method", "path", "ctype", "now", "set", "trade", "auth", "sql", "req_headers")}
        if isinstance(s["body"], bytes):
            rec["body_b64"] = base64.b64encode(s["body"]).decode()
            rec["body"] = None
        elif isinstance(s["body"], dict):
            rec["body_spec"] = s["body"]
            rec["body"] = None
        else:
            rec["body"] = s["body"]
        rec.update({"status": status,
                    "headers": {k: headers[k] for k in ("content-type", "cache-control", "retry-after", "allow") if k in headers},
                    "all_headers": sorted(headers.keys()),
                    # a D3 answer is compared with `expect`; the bot's PNG body itself is only fingerprinted
                    "raw_b64": base64.b64encode(raw).decode() if expect is None else None,
                    "raw_len": len(raw), "raw_sha1": hashlib.sha1(raw).hexdigest(),
                    "expect": expect, "mismatch": mismatch,
                    "logs": list(LOGS.lines), "bot_calls": [c[0] for c in BOT_OBJ.calls]})
        if s["uid"] is not None and s["auth"] == "test":
            rec["kv"] = kv_snapshot(con2, s["uid"])
            rec["mem"] = mem_snapshot(s["uid"])
            rec["user_row"] = con2.execute("SELECT COUNT(*) FROM users WHERE user_id=?", (s["uid"],)).fetchone()[0]
        if s.get("trade") is not None:
            rec["trade_state"] = trade_snapshot(con2, s["trade"])
        if fam in ("feedback", "body", "postbucket", "auth"):
            rec["feedback_rows"] = [list(r) for r in con2.execute("SELECT id, user_id, type, text FROM feedback ORDER BY id").fetchall()]
        con2.close()
        out.append(rec)
    await server.close()
    fixture = {
        "generator": "tests/app/diff/py/drive_app_diff.py", "python": sys.version.split()[0],
        "units": unit_vectors(), "now": NOW, "users": USERS, "fresh_uid": FRESH_UID, "trades": trades, "trade_keys": TRADE_KEYS,
        "seeded_types": seeded_types, "events": EVENTS, "kv": KV, "feedback_seed": FEEDBACK_SEED,
        "cache_seed": CACHE_SEED, "rest_seed": REST_SEED, "tickers": TICKERS, "trend_raw": TREND_RAW, "steps": out,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with gzip.open(OUT, "wt", encoding="utf-8") as fh:
        json.dump(fixture, fh, ensure_ascii=True, allow_nan=True)
    fams: dict = {}
    for r in out:
        fams[r["family"]] = fams.get(r["family"], 0) + 1
    print(len(USERS), "users,", len(trades), "trades,", len(out), "steps →", OUT)
    print("families:", fams)
    print("statuses:", sorted({r["status"] for r in out}))
    bad = [(r["name"], r["mismatch"]) for r in out if r["mismatch"]]
    print("mirror mismatches:", bad)


asyncio.run(main())
sys.stdout.flush()
os._exit(0)      # aiosqlite's reader threads would keep the interpreter alive
