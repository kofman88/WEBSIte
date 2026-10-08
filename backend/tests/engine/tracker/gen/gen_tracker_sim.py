"""gen_tracker_sim.py — a multi-cycle simulation of the bot's REAL signal_tracker.run_cycle
(db/signal_progress.py on a bot-schema SQLite, the real _CandleSource / process_trade /
mark_missed / expire_stale) for the JS parity test backend/tests/engine/tracker/sim.test.js.

150 random delivered signals (market and SMC-zone entries, LONG/SHORT, moved stops,
exchange-managed / manual-result / undelivered / ghost-SKIP rows, broken card snapshots)
are inserted as their created_at passes and tracked over ~100 h of cycles at irregular
times. The candles are 5m micro bars from a MINSTD generator (bit-identical in JS),
aggregated into 15m / 1H frames that INCLUDE the forming bar (partial high/low), so the
transition-bar logic (full=False) is exercised across cycles. Per symbol the cache is
full / short (REST fallback, budget 3 per cycle) / raising / missing, and the current
price comes from the cache or the 1H fallback.

Recorded per cycle: the rows inserted, every DB change (progress_stage, progress_ts,
expire_rr), card edits (text, keyboard kept), progress sends (text, silent, reply_to,
photo), chart windows (len + first bar of _chart_df), the INFO/WARNING log lines and the
run_cycle return value.

Run with the bot's venv (the script chdirs into the bot checkout itself; OUT absolute):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python gen_tracker_sim.py /abs/tracker_sim.json
  (afterwards: rm -f <bot>/signal_registry.json)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import sys
import tempfile
import time as _time
from types import SimpleNamespace

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
os.chdir(BOT)
sys.path.insert(0, BOT)
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")

import pandas as pd  # noqa: E402

import cache as bot_cache  # noqa: E402
import database  # noqa: E402
import signal_freshness  # noqa: E402
import signal_tracker as st  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else "tracker_sim.json"

# ── deterministic generator shared with the JS test (MINSTD, exact in doubles) ──


class Minstd:
    def __init__(self, seed: int):
        self.x = seed % 2147483647 or 1

    def u(self) -> float:
        self.x = (self.x * 48271) % 2147483647
        return self.x / 2147483647

    def int(self, n: int) -> int:          # 0..n-1
        return int(self.u() * n) % n

    def choice(self, seq):
        return seq[self.int(len(seq))]


MICRO = 300
T0 = 1_766_000_400.0                       # sim start (aligned to 5m)
HIST_H = 150                               # micro history before T0
SIM_H = 100
SYMBOLS = [
    # symbol, base price, vol per micro bar, cache mode, price mode
    ("BTC-USDT-SWAP", 65000.5, 0.0035, "full", "cache"),
    ("ETH-USDT-SWAP", 2500.25, 0.0045, "short", "cache"),
    ("SOL-USDT-SWAP", 150.125, 0.006, "full", "none"),
    ("PEPE-USDT-SWAP", 0.0000123, 0.008, "raise", "cache"),
    ("DOGE-USDT-SWAP", 0.1234, 0.006, "missing", "cache"),
    ("XRP-USDT-SWAP", 0.55, 0.005, "short", "none"),
    ("ADA-USDT-SWAP", 0.45, 0.005, "full", "cache"),
    ("LINK-USDT-SWAP", 14.5, 0.0055, "full", "cache"),
]
N_MICRO = int((HIST_H + SIM_H) * 3600 / MICRO)
M0 = T0 - HIST_H * 3600                    # first micro bar open


def gen_micro(seed: int, p0: float, vol: float):
    g = Minstd(seed)
    p = p0
    bars = []
    for i in range(N_MICRO):
        t = M0 + i * MICRO
        u1, u2, u3, u4 = g.u(), g.u(), g.u(), g.u()
        o = p
        c = o + (u1 - 0.5) * vol * o
        hi = max(o, c) + u2 * vol * o * 0.5
        lo = min(o, c) - u3 * vol * o * 0.5
        if u4 > 0.985:                     # spike: wide bar (SL and TP in one bar)
            hi = hi + vol * o * 3.0
            lo = lo - vol * o * 3.0
        p = c
        bars.append((t, o, hi, lo, c))
    return bars


MICROS = {s: gen_micro(1000 + k * 7919, p0, vol) for k, (s, p0, vol, _cm, _pm) in enumerate(SYMBOLS)}
TFSEC = {"15m": 900, "1H": 3600}


def frame_at(symbol: str, tf: str, now: float, limit: int = 300):
    """TF bars at `now` from completed micro bars, the forming bar included; last `limit`."""
    tfs = TFSEC[tf]
    out = []
    cur = None
    for (t, o, h, lo, c) in MICROS[symbol]:
        if t + MICRO > now:
            break
        b = (t // tfs) * tfs
        if cur is None or cur[0] != b:
            if cur is not None:
                out.append(cur)
            cur = [b, o, h, lo, c]
        else:
            cur[2] = max(cur[2], h)
            cur[3] = min(cur[3], lo)
            cur[4] = c
    if cur is not None:
        out.append(cur)
    return out[-limit:]


def to_df(rows):
    if not rows:
        return None
    df = pd.DataFrame(rows, columns=["open_time", "open", "high", "low", "close"]).astype(float)
    df["volume"] = 1.0
    df.index = pd.to_datetime((df["open_time"] * 1000).astype("int64"), unit="ms")
    df.index.name = "open_time"
    return df.drop(columns=["open_time"])


# ── trades ──────────────────────────────────────────────────────────────────
g = Minstd(424242)
USERS = {
    201: dict(lang="ru", progress_notify_enabled=True, send_chart_enabled=True, sub_plan="pro", quiet_start=-1, quiet_end=-1),
    202: dict(lang="en", progress_notify_enabled=True, send_chart_enabled=False, sub_plan="free", quiet_start=22, quiet_end=7),
    203: dict(lang="ru", progress_notify_enabled=False, send_chart_enabled=True, sub_plan="pro", quiet_start=-1, quiet_end=-1),
    204: dict(lang=None, progress_notify_enabled=True, send_chart_enabled=True, sub_plan="free", quiet_start=1, quiet_end=10),
    205: dict(lang="en", progress_notify_enabled=True, send_chart_enabled=True, sub_plan="", quiet_start=9, quiet_end=18),
    206: dict(lang="ru", progress_notify_enabled=True, send_chart_enabled=True, sub_plan="pro", quiet_start=23, quiet_end=8),
    207: dict(lang="ru", progress_notify_enabled=True, send_chart_enabled=False, sub_plan="pro", quiet_start=-1, quiet_end=-1),  # blocks the bot
}
UIDS = list(USERS) + [209]                 # 209: um.get → None
BLOCKER = 207
CARDS = [
    json.dumps({"html": "<b>🟢 BTC LONG</b>\nВход 100\nSL 95", "kb": {"inline_keyboard": [[{"text": "📋 Результат", "callback_data": "res_x"}]]}}, ensure_ascii=False),
    json.dumps({"html": "<b>SMC</b> card  \n \t", "kb": None}, ensure_ascii=False),
    json.dumps({"html": "<b>card</b>\n\n📌 old outcome line", "kb": None}, ensure_ascii=False),
    "",
    "not json {",
    json.dumps({"html": ""}),
    json.dumps({"html": "x" * 3990}),
]

trades = []
for k in range(150):
    sym, p0, vol, _cm, _pm = SYMBOLS[g.int(len(SYMBOLS))]
    micro = MICROS[sym]
    # created between T0-100h and T0+SIM_H-2h (micro index), plus a fractional offset
    lo_i = int((HIST_H - 100) * 3600 / MICRO)
    hi_i = int((HIST_H + SIM_H - 2) * 3600 / MICRO)
    i = lo_i + g.int(hi_i - lo_i)
    t_i, _o, _h, _l, c_i = micro[i]
    created = t_i + MICRO + float(g.int(29900)) / 100.0 + k * 1e-3
    direction = "LONG" if g.u() < 0.5 else "SHORT"
    sgn = 1.0 if direction == "LONG" else -1.0
    risk = c_i * (0.003 + g.u() * 0.017)
    zone = g.u() < 0.4
    if zone:
        hi_z = c_i - sgn * (g.u() * 1.2) * risk
        lo_z = hi_z - sgn * (0.2 + g.u() * 0.5) * risk
        entry = (hi_z + lo_z) / 2.0
        e_lo, e_hi = (min(lo_z, hi_z), max(lo_z, hi_z))
        if g.u() < 0.15:
            e_lo, e_hi = e_hi, e_lo        # swapped zone bounds
    else:
        entry = c_i
        e_lo = e_hi = 0.0
    sl = entry - sgn * risk
    r1 = 0.8 + g.u() * 1.5
    r2 = r1 + 0.5 + g.u() * 1.5
    r3 = r2 + 0.5 + g.u() * 2.0
    tr = {
        "trade_id": f"sim{k:03d}_{sym[:4]}", "user_id": UIDS[g.int(len(UIDS))], "symbol": sym,
        "direction": direction, "entry": entry, "sl": sl,
        "tp1": entry + sgn * r1 * risk, "tp2": entry + sgn * r2 * risk, "tp3": entry + sgn * r3 * risk,
        "timeframe": g.choice(["15m", "1h", "4h", "5m", "1H", ""]),
        "strategy": g.choice(["LEVELS", "SMC", "VOLUME", "smc", ""]),
        "created_at": created, "entry_lo": e_lo, "entry_hi": e_hi,
        "signal_msg_id": 1000 + k, "signal_card_json": g.choice(CARDS),
        "order_id": "", "result": "", "progress_stage": "", "progress_ts": 0.0,
    }
    v = g.u()
    if v < 0.25:
        tr["original_sl"] = sl
        tr["sl"] = entry                   # moved to break-even, original kept
    elif v < 0.30:
        tr["original_sl"] = 0.0
    elif v < 0.33:
        tr["original_sl"] = None
    w = g.u()
    if w < 0.05:
        tr["order_id"] = "ord-%d" % k      # exchange-managed
    elif w < 0.08:
        tr["result"] = "MANUAL"
    elif w < 0.12:
        tr["signal_msg_id"] = 0           # never delivered
    elif w < 0.18:
        tr["result"] = "SKIP"             # ghost-cleaned delivered row: still tracked
    elif w < 0.20:
        tr["order_id"] = "   "            # whitespace order id: tracked by the SQL? no ('' only)
    elif w < 0.22:
        tr["progress_stage"] = "ENTRY"
        tr["progress_ts"] = created + 1.0
    elif w < 0.24:
        tr["tp3"] = 0.0
    elif w < 0.25:
        tr["entry"] = 0.0                 # invalid levels
    trades.append(tr)

TRADE_COLS = ["trade_id", "user_id", "symbol", "direction", "entry", "sl", "tp1", "tp2", "tp3",
              "timeframe", "strategy", "created_at", "entry_lo", "entry_hi", "signal_msg_id",
              "signal_card_json", "order_id", "result", "progress_stage", "progress_ts", "original_sl"]

# ── the bot under test with fakes for cache / price / bot / users ──────────
tmp = tempfile.mkdtemp(prefix="m10a_sim_")
DBP = os.path.join(tmp, "bot.db")
LOOP = asyncio.new_event_loop()
asyncio.set_event_loop(LOOP)
LOOP.run_until_complete(database.init_db(DBP))

NOW = [T0]
_time.time = lambda: NOW[0]                # _CandleSource.last_price reads time.time()
st.SEND_DELAY_S = 0.0
st._CandleSource.__init__.__defaults__ = (None, 3)   # REST budget 3 per cycle (JS: config.REST_PER_CYCLE=3)
st.REST_PER_CYCLE = 3                      # the cycle log line uses the module constant

MODES = {s: (cm, pm) for (s, _p, _v, cm, pm) in SYMBOLS}


async def fake_get_candles(symbol, tf):
    cm = MODES[symbol][0]
    if cm == "raise":
        raise RuntimeError("cache down")
    if cm == "missing":
        return None
    rows = frame_at(symbol, tf, NOW[0], 300 if cm == "full" else 40)
    return to_df(rows)


class Fetcher:
    calls: list = []

    async def get_candles(self, symbol, tf, limit=300):
        Fetcher.calls.append([symbol, tf, limit])
        if symbol == "DOGE-USDT-SWAP" and tf == "1H":
            return None                    # REST has nothing either
        return to_df(frame_at(symbol, tf, NOW[0], limit))


async def fake_price(symbol):
    if MODES[symbol][1] == "none":
        return None
    rows = frame_at(symbol, "15m", NOW[0], 2)
    return rows[-1][4] if rows else None


bot_cache.get_candles = fake_get_candles
signal_freshness.get_current_price = fake_price

RENDERS: list = []


def fake_render(df, trade, L, event, hit, tier, lang):
    RENDERS.append({"trade_id": trade.get("trade_id"), "len": int(len(df)),
                    "from_ts": float((df.index[0] - pd.Timestamp(0)).total_seconds()) if len(df) else None,
                    "event": event, "hit": list(hit), "tier": tier, "lang": lang})
    return b"PNG"


st._render_png = fake_render


class TelegramForbiddenError(Exception):
    pass


import aiogram.exceptions as _aex  # noqa: E402

try:
    from aiogram.methods import SendMessage as _SM
    _FORBIDDEN = _aex.TelegramForbiddenError(method=_SM(chat_id=1, text="x"), message="Forbidden: bot was blocked by the user")
except Exception:  # pragma: no cover
    _FORBIDDEN = TelegramForbiddenError("blocked")


class FakeBot:
    def __init__(self):
        self.edits: list = []
        self.sends: list = []

    async def edit_message_text(self, chat_id, message_id, text, parse_mode=None, reply_markup=None,
                                disable_web_page_preview=None):
        self.edits.append({"uid": chat_id, "mid": message_id, "text": text, "kb": reply_markup is not None})

    async def _send(self, uid, text, kw, photo):
        if uid == BLOCKER:
            raise _FORBIDDEN
        rp = kw.get("reply_parameters")
        self.sends.append({"uid": uid, "text": text, "silent": bool(kw.get("disable_notification", False)),
                           "reply_to": int(rp.message_id) if rp is not None else 0, "photo": photo})

    async def send_message(self, uid, text, **kw):
        await self._send(uid, text, kw, False)

    async def send_photo(self, uid, photo, caption=None, **kw):
        await self._send(uid, caption, kw, True)


class UM:
    async def get(self, uid):
        u = USERS.get(int(uid))
        return SimpleNamespace(**u) if u is not None else None


LOG_LINES: list = []


class _Cap(logging.Handler):
    def emit(self, record):
        if record.levelno >= logging.INFO:
            LOG_LINES.append(record.getMessage())


logging.getLogger("CHM.SignalTracker").addHandler(_Cap())
logging.getLogger("CHM.SignalTracker").setLevel(logging.INFO)


def db_rows():
    con = sqlite3.connect(DBP)
    con.row_factory = sqlite3.Row
    rows = {r["trade_id"]: (r["progress_stage"], r["progress_ts"], r["expire_rr"])
            for r in con.execute("SELECT trade_id, progress_stage, progress_ts, expire_rr FROM trades")}
    con.close()
    return rows


def insert(tr):
    con = sqlite3.connect(DBP)
    cols = [c for c in TRADE_COLS if c in tr]
    con.execute(f"INSERT INTO trades ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                [tr[c] for c in cols])
    con.commit()
    con.close()


bot = FakeBot()
um = UM()
fetcher = Fetcher()
cg = Minstd(777)
cycles = []
inserted: set = set()
now = T0
prev = {}
st._blocked_users.clear()
while now < T0 + SIM_H * 3600:
    NOW[0] = now
    new_ids = []
    for tr in trades:
        if tr["trade_id"] not in inserted and tr["created_at"] <= now:
            insert(tr)
            inserted.add(tr["trade_id"])
            new_ids.append(tr["trade_id"])
    bot.edits, bot.sends, LOG_LINES[:], RENDERS[:], Fetcher.calls = [], [], [], [], []
    sent = LOOP.run_until_complete(st.run_cycle(bot, um, fetcher, now=now))
    cur = db_rows()
    for tid in new_ids:
        tr0 = next(t for t in trades if t["trade_id"] == tid)
        prev[tid] = (tr0["progress_stage"], float(tr0["progress_ts"]), None)
    changes = {tid: list(v) for tid, v in cur.items() if prev.get(tid) != v}
    prev = cur
    cycles.append({"now": now, "inserted": new_ids, "sent": sent, "changes": changes,
                   "edits": list(bot.edits), "sends": list(bot.sends), "renders": list(RENDERS),
                   "rest": list(Fetcher.calls), "logs": list(LOG_LINES)})
    now = now + 60.0 + cg.int(5340) + cg.u()

final = {tid: list(v) for tid, v in db_rows().items()}
stages = {}
for v in final.values():
    stages[v[0]] = stages.get(v[0], 0) + 1
json.dump({"T0": T0, "SIM_H": SIM_H, "HIST_H": HIST_H, "MICRO": MICRO,
           "symbols": [list(s) for s in SYMBOLS], "users": {str(k): v for k, v in USERS.items()},
           "blocker": BLOCKER, "trades": trades, "trade_cols": TRADE_COLS, "cycles": cycles,
           "final": final, "stage_counts": stages, "blocked": sorted(st._blocked_users)},
          open(OUT, "w"), ensure_ascii=False)
print("cycles", len(cycles), "stages", stages, "sends", sum(len(c["sends"]) for c in cycles),
      "edits", sum(len(c["edits"]) for c in cycles), "rest", sum(len(c["rest"]) for c in cycles),
      "renders", sum(len(c["renders"]) for c in cycles), "blocked", sorted(st._blocked_users))
sys.stdout.flush()
os._exit(0)                                # aiosqlite worker threads would keep the process alive
