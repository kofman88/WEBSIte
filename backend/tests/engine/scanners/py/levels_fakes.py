"""levels_fakes.py — the shared test doubles of the scanner differential drivers
(levels_scan.py = scanner_mid.MidScanner, volume_scan.py = volume_scanner).

Everything the bot reaches outside its own process is replaced, nothing else:

  clock      time.time() is pinned to CLK.t (every bot module calls time.time()); free_report's
             datetime.now(timezone.utc) follows the same clock
  random     random.randint → a counter sequence the JS replay reproduces (RAND)
  market     FakeFetcher: REST candles = the golden candle fixtures cut at the clock (closed bars
             only, last `limit`), get_all_usdt_pairs over a fixed 24 h volume table, a fixed
             global trend; every call is recorded
  telegram   FakeBot.send_message: records the call (text, flags, keyboard as model_dump) and
             returns a Message-like object (message_id from a counter, html_text = text); uids in
             FakeBot.fail raise TelegramForbiddenError (safe_send_message → False)
  exchange   auto_trade.execute_auto_trade → a recorded fake with a per-user canned result
             (no exchange call), balance_cache.get_cached_balance → a per-user canned balance,
             exchange_symbols metric emitter → no-op
  misc       chart_sender.send_signal_chart_bg / metrics.record → recorded no-ops,
             fundamental.get_market_context_block → the cycle's canned block,
             optimizer.load_params → the canned optimizer_params per (uid, strategy)

The bot checkout is only read: the driver chdirs into it for its imports, the database lives in
a temp dir, signal_registry persists to a temp file.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import sys

sys.dont_write_bytecode = True   # never write .pyc files into the bot checkout
import tempfile
import time as _time
from datetime import datetime, timezone
from types import SimpleNamespace

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
HERE = os.path.dirname(os.path.abspath(__file__))
SITE_BACKEND = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
GOLDEN_CANDLES = os.path.join(SITE_BACKEND, "tests", "golden", "candles")

os.chdir(BOT)
sys.path.insert(0, BOT)
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
for _k in ("CACHE_FIRST_MODE", "LEVELS_RELAX_ENABLED", "LEVELS_REGIME_GATE", "LEVELS_VOL_GATE",
           "LEVELS_ENTRY_CONFIRM", "LEVELS_MIN_RR", "SIGNAL_MAX_DRIFT_R", "MOMENTUM_VETO_ENABLED",
           "TREND_MTF_BONUS", "TREND_STRONG_PCT", "TREND_STRONG_COUNTER_PENALTY", "TREND_CTX_RISK",
           "FRESHNESS_BASELINE_S", "POST_CLOSE_COOLDOWN_SEC", "LEVELS_CYCLE_TIMEOUT_S"):
    os.environ.pop(_k, None)
TMP = tempfile.mkdtemp(prefix="m9b_scan_")
os.environ["DB_PATH"] = os.path.join(TMP, "bot.db")
try:
    from cryptography.fernet import Fernet  # noqa: E402
    os.environ["BYBIT_FERNET_KEY"] = Fernet.generate_key().decode()
except Exception:   # pragma: no cover
    pass

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

TF_MS = {"15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
_TF_ALIAS = {"15m": "15m", "1h": "1h", "1H": "1h", "4h": "4h", "4H": "4h", "1d": "1d", "1D": "1d"}


# ── clock ──────────────────────────────────────────────────────────────────
class Clock:
    def __init__(self, t: float = 0.0):
        self.t = float(t)

    def time(self) -> float:
        return self.t


CLK = Clock(0.0)
_time.time = CLK.time


class FakeDT(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime.fromtimestamp(CLK.t, tz)

    @classmethod
    def utcnow(cls):
        return datetime.utcfromtimestamp(CLK.t)


# ── random ─────────────────────────────────────────────────────────────────
class Rand:
    """randint(a, b) = a + (37·k + 11) mod (b − a + 1), k = 0, 1, 2 … (shared with the JS replay)."""

    def __init__(self):
        self.k = 0

    def randint(self, a, b):
        span = b - a + 1
        v = a + (37 * self.k + 11) % span
        self.k += 1
        return v


RAND = Rand()
import random as _random  # noqa: E402
_random.randint = RAND.randint


# ── candles ────────────────────────────────────────────────────────────────
_RAW: dict = {}


def raw(symbol: str, tf: str):
    key = (symbol, tf)
    if key not in _RAW:
        p = os.path.join(GOLDEN_CANDLES, f"{symbol}_{tf}.json")
        if not os.path.exists(p):
            _RAW[key] = None
        else:
            with open(p) as fh:
                _RAW[key] = np.array(json.load(fh)["bars"], dtype=float)
    return _RAW[key]


def golden_symbols() -> list:
    with open(os.path.join(GOLDEN_CANDLES, "index.json")) as fh:
        return [f["symbol"] for f in json.load(fh)["fixtures"]]


def frame_at(symbol: str, tf: str, now_s: float, limit: int = 300):
    """Closed bars at `now_s` (open + tf <= now), last `limit` — what fetcher_bingx returns."""
    t = _TF_ALIAS.get(tf, tf)
    arr = raw(symbol, t)
    if arr is None:
        return None
    now_ms = int(now_s * 1000)
    n = int(np.searchsorted(arr[:, 0] + TF_MS[t], now_ms, side="right"))
    sub = arr[max(0, n - limit):n] if limit else arr[:n]
    if not len(sub):
        return None
    idx = pd.to_datetime(sub[:, 0].astype("int64"), unit="ms")
    df = pd.DataFrame({"open": sub[:, 1], "high": sub[:, 2], "low": sub[:, 3],
                       "close": sub[:, 4], "volume": sub[:, 5]}, index=idx)
    df.index.name = "open_time"
    return df


# ── market data ────────────────────────────────────────────────────────────
class FakeFetcher:
    def __init__(self, volumes: dict, global_trend: dict | None = None):
        self.volumes = dict(volumes)          # symbol → 24 h USDT volume (fixed)
        self.vol_by_sym: dict = {}
        self.global_trend = global_trend or {}
        self.calls: list = []
        self.missing: set = set()             # symbols whose REST call returns None
        self.raise_on: set = set()            # (symbol, tf) whose REST call raises

    async def get_candles(self, symbol, tf, limit=300):
        self.calls.append(["candles", symbol, tf, int(limit)])
        if (symbol, tf) in self.raise_on:
            raise RuntimeError("rest down")
        if symbol in self.missing:
            return None
        return frame_at(symbol, tf, CLK.t, int(limit))

    async def get_all_usdt_pairs(self, min_volume_usdt=1_000_000, blacklist=None, max_coins=0):
        """Symbols with volume ≥ min, minus the blacklist, by volume desc (stable), capped;
        vol_by_sym = the symbols that passed (like the BingX fetcher)."""
        self.calls.append(["pairs", float(min_volume_usdt), sorted(blacklist or []), int(max_coins)])
        bl = set(blacklist or [])
        items = [(s, v) for s, v in self.volumes.items() if v >= min_volume_usdt and s not in bl]
        items.sort(key=lambda kv: kv[1], reverse=True)
        if max_coins:
            items = items[:max_coins]
        self.vol_by_sym = {s: v for s, v in items}
        return [s for s, _ in items]

    async def get_global_trend(self):
        self.calls.append(["global_trend"])
        return self.global_trend


# ── telegram ───────────────────────────────────────────────────────────────
def kb_dump(markup):
    if markup is None:
        return None
    dump = getattr(markup, "model_dump", None)
    return dump(exclude_none=True) if callable(dump) else None


class FakeBot:
    def __init__(self):
        self.sent: list = []
        self.fail: set = set()
        self.next_id = 5000

    async def send_message(self, chat_id, text, **kw):
        rec = {"uid": int(chat_id), "text": text, "parse_mode": kw.get("parse_mode"),
               "protect_content": bool(kw.get("protect_content", False)),
               "disable_notification": bool(kw.get("disable_notification", False)),
               "kb": kb_dump(kw.get("reply_markup"))}
        if int(chat_id) in self.fail:
            from aiogram.exceptions import TelegramForbiddenError
            from aiogram.methods import SendMessage
            rec["failed"] = True
            self.sent.append(rec)
            raise TelegramForbiddenError(method=SendMessage(chat_id=chat_id, text="x"), message="Forbidden: bot was blocked by the user")
        self.next_id += 1
        rec["message_id"] = self.next_id
        self.sent.append(rec)
        return SimpleNamespace(message_id=self.next_id, html_text=text, text=text, reply_markup=kw.get("reply_markup"))


# ── log capture ────────────────────────────────────────────────────────────
class Capture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.INFO)
        self.lines: list = []

    def emit(self, record):
        self.lines.append([record.levelname, record.name, record.getMessage()])


def capture_logs():
    cap = Capture()
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(cap)
    for name in ("aiosqlite", "asyncio", "urllib3", "matplotlib", "PIL"):
        logging.getLogger(name).setLevel(logging.WARNING)
    return cap


# ── JSON encoding of the observations ──────────────────────────────────────
def enc(x):
    if isinstance(x, float) and not math.isfinite(x):
        return {"$f": "nan" if math.isnan(x) else ("inf" if x > 0 else "-inf")}
    if isinstance(x, (np.floating,)):
        return enc(float(x))
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.bool_,)):
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


def ms_of(ts) -> int:
    if isinstance(ts, pd.Timestamp):
        return int(ts.value // 1_000_000)
    return int(ts)


def write_json(path: str, doc, gz: bool = False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = json.dumps(enc(doc), ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
    if gz:
        import gzip
        with open(path, "wb") as raw_fh, gzip.GzipFile(filename="", mode="wb", compresslevel=9,
                                                      fileobj=raw_fh, mtime=0) as fh:
            fh.write(data.encode("utf-8"))
    else:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(data)
    print("wrote", path, len(data), "bytes")


# ── DB snapshots ───────────────────────────────────────────────────────────
SITE_TRADE_COLS = [
    "trade_id", "user_id", "symbol", "direction", "entry", "sl", "tp1", "tp2", "tp3", "tp1_rr", "tp2_rr",
    "tp3_rr", "quality", "timeframe", "breakout_type", "result", "result_rr", "created_at", "trail_level",
    "order_id", "be_set", "tp_placed", "risk_pct", "pos_idx", "leverage", "strategy", "copied_from", "state",
    "state_changed_at", "placement_attempts", "closed_pnl_usd", "qty", "original_sl", "order_link_id",
    "signal_type", "skip_reason", "entry_lo", "entry_hi", "exchange", "tp_retry_count", "rsi", "volume_ratio",
    "is_counter_trend", "mtf_aligned", "trend_ctx", "btc_corr", "session", "preset_name", "ai_filter_json",
    "signal_msg_id", "progress_stage", "progress_ts", "signal_card_json", "expire_rr", "user_note",
]

USER_STATE_COLS = [
    "user_id", "active", "long_active", "short_active", "smc_long_active", "smc_short_active",
    "vol_long_active", "vol_short_active", "sub_status", "sub_plan", "expired_notified", "signals_received",
    "free_signals_date", "free_signals_morning", "free_signals_evening", "free_signals_night",
    "free_signals_today", "free_missed_today", "free_smc_preview_today", "free_smc_preview_date",
]


def sqlite_rows(sql: str, params=()):
    import sqlite3
    con = sqlite3.connect(os.environ["DB_PATH"])
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql, params).fetchall()]
    finally:
        con.close()


def trades_snapshot():
    rows = sqlite_rows("SELECT * FROM trades ORDER BY rowid")
    return [{c: r.get(c) for c in SITE_TRADE_COLS} for r in rows]


def trade_events_snapshot():
    return sqlite_rows("SELECT trade_id, ts, event_type, payload_json FROM trade_events ORDER BY id")


def kv_snapshot():
    return {r["key"]: r["value"] for r in sqlite_rows("SELECT key, value FROM kv ORDER BY key")}


def users_snapshot():
    rows = sqlite_rows("SELECT * FROM users ORDER BY user_id")
    return [{c: r.get(c) for c in USER_STATE_COLS} for r in rows]


async def drain(loop_rounds: int = 20):
    """Let the bot's fire-and-forget tasks (trade_events, signal_msg_id, kv saves) finish."""
    for _ in range(loop_rounds):
        await asyncio.sleep(0)
    me = asyncio.current_task()
    pending = [t for t in asyncio.all_tasks() if t is not me and not t.done()]
    if pending:
        await asyncio.wait(pending, timeout=5)
    for _ in range(loop_rounds):
        await asyncio.sleep(0)


# ── bot-tree integrity ─────────────────────────────────────────────────────
def tree_snapshot(root: str = BOT) -> dict:
    import hashlib
    out = {}
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d not in ("__pycache__", ".git")]
        for f in fn:
            p = os.path.join(dp, f)
            try:
                with open(p, "rb") as fh:
                    out[os.path.relpath(p, root)] = (os.path.getsize(p), hashlib.sha1(fh.read()).hexdigest())
            except OSError:
                pass
    return out


def tree_diff(before: dict, after: dict) -> list:
    keys = set(before) | set(after)
    return sorted(k for k in keys if before.get(k) != after.get(k))
