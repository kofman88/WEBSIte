"""gen_m15_units.py — PLAN_M15 U1 vectors from the bot's own code (bot HEAD 1a47ffc).

Writes backend/tests/autotrade/m15/fixtures/m15_units.json.gz for tests/autotrade/m15/units.test.js,
harness.selftest.test.js and asyncio.test.js:

  fallback_pnl   db/trades.compute_fallback_pnl_usd over a hand table (non-numeric, None, bools, lists,
                 ≤ 0, NaN / inf strings, LONG / SHORT / "short" / "" / None directions, 1000× coins) and
                 300 seeded random rows
  readers        ONE seeded bot DB (users via UserSettings → db_upsert_user with Fernet keys + raw column
                 overrides; 501 open exchange rows and every exclusion class) read by
                 db_get_open_trades_all, db_get_all_stale_open_trades (three cutoffs, [GHOST-LIVE-TRADES]),
                 db_get_user (every uid + a missing one), db_get_all_users and
                 user_manager.get_active_auto_trade_users at a pinned clock; the seeds are in the fixture,
                 the JS test writes the same rows into a site DB; EXPLAIN QUERY PLAN of the four reads
  active_retry   user_manager.get_active_auto_trade_users with db_get_active_users' connection raising
                 'database is locked': the 3 queries, the retry WARNINGs, and a wait_for timeout / task.cancel()
                 during the 1 s / 2 s back-off (the sleep is a cancellation point: no further query)
  alert          admin_alerts.alert_be_monitor_crash on a recording bot: texts for None / "" / HTML / 450
                 code points / astral characters, the 6 h dedup (kv value), the per-type TTL table
  i18n           i18n.t(key, lang, **kw) for the M15 keys (both languages, lang fallbacks, missing /
                 mistyped kwargs → raw text) — the round trip of gen_messages.py → messagesData.json
  sigs           inspect.signature of the M15 trader functions of the four bot traders (presence and
                 positional parameters — the bot→site positional map of harness.js / callMaps.js)
  harness        m15_harness.self_test(): the scripted fake-trader calls, answers, timings, delivery /
                 log / call-recorder records, same-instant timer order (FIFO), and asyncio.Semaphore traces
                 (CPython 3.11.17) for createSemaphore (tie scenarios, the guarded same-instant cancel)

  cd /home/user/MAIN_BOT/CHM_BREAKER_V4
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> -I -B <site>/backend/tests/autotrade/m15/py/gen_m15_units.py [OUT]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import m15_harness as H  # noqa: E402  (sandbox + virtual clock first)

import dataclasses  # noqa: E402
import inspect  # noqa: E402
import random  # noqa: E402

OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(H.FIXTURES, "m15_units.json.gz")
NOW = H.WALL0 + 10 * 86400 + 3600.25        # 2026-01-11 01:00:00.25 UTC
D = 86400.0

# ── 1. compute_fallback_pnl_usd ──────────────────────────────────────────────
FALLBACK_TABLE = [
    (100.0, 110.0, 2.0, "LONG"), (100.0, 110.0, 2.0, "SHORT"), (100.0, 90.0, 2.0, "LONG"), (100.0, 90.0, 2.0, "SHORT"),
    (100.0, 110.0, 2.0, "short"), (100.0, 110.0, 2.0, "long"), (100.0, 110.0, 2.0, ""), (100.0, 110.0, 2.0, None),
    (100.0, 110.0, 2.0, " LONG"), (100.0, 110.0, 2.0, "LONG "), (100.0, 110.0, 2.0, "Buy"), (100.0, 110.0, 2.0, 1),
    (100.0, 110.0, 2.0, "ſhort"), (100.0, 110.0, 2.0, "loNg"),
    (0.0, 110.0, 2.0, "LONG"), (100.0, 0.0, 2.0, "LONG"), (100.0, 110.0, 0.0, "LONG"), (-1.0, 110.0, 2.0, "LONG"),
    (100.0, -5.0, 2.0, "SHORT"), (100.0, 110.0, -0.0, "LONG"), (100.0, 110.0, -2.0, "SHORT"),
    ("100", "110", "2", "LONG"), (" 100.5 ", "99.25\n", "3", "SHORT"), ("1_000", "1_100", "1", "LONG"),
    ("abc", 110.0, 2.0, "LONG"), (100.0, "", 2.0, "LONG"), (100.0, 110.0, "x2", "LONG"), (None, 110.0, 2.0, "LONG"),
    (100.0, None, 2.0, "LONG"), (100.0, 110.0, None, "LONG"), ([100], 110.0, 2.0, "LONG"), ({"a": 1}, 110.0, 2.0, "LONG"),
    (True, 2.0, 3.0, "LONG"), (False, 2.0, 3.0, "LONG"), (100, 110, 2, "LONG"),
    ("nan", 110.0, 2.0, "LONG"), (100.0, "inf", 2.0, "LONG"), (100.0, 110.0, "infinity", "SHORT"), ("-inf", 1.0, 1.0, "LONG"),
    ("1e3", "1.1e3", "0.5", "LONG"), ("0x10", 1.0, 1.0, "LONG"),
    # 1000× coins: the price / qty pair of the same row in one unit convention
    (0.000012345, 0.000013579, 81000000.0, "LONG"), (0.012345, 0.013579, 81000.0, "LONG"),
    (0.0000098765, 0.0000091234, 1.5e7, "SHORT"), (0.0098765, 0.0091234, 15000.0, "SHORT"),
    (87000.5, 88500.0, 0.012, "LONG"), (87000.5, 86000.0, 0.0115, "SHORT"), (3.1415926, 2.7182818, 1234.5678, "LONG"),
    (1e-300, 2e-300, 1e300, "LONG"), (1e300, 1e300, 1e10, "SHORT"), (5e-324, 1e-323, 1.0, "LONG"),
]


def fallback_rows():
    from db.trades import compute_fallback_pnl_usd
    rows = [[list(a), compute_fallback_pnl_usd(*a)] for a in FALLBACK_TABLE]
    rnd = random.Random(20261010)
    for _ in range(300):
        e = rnd.choice([rnd.uniform(0.00001, 0.01), rnd.uniform(0.5, 50), rnd.uniform(100, 100000)])
        x = e * rnd.uniform(0.8, 1.25)
        q = rnd.choice([rnd.uniform(0.001, 5), rnd.uniform(10, 1e6), float(rnd.randint(1, 1000))])
        d = rnd.choice(["LONG", "SHORT", "long", "short", ""])
        args = [e, x, q, d]
        if rnd.random() < 0.15:
            i = rnd.randrange(3)
            args[i] = rnd.choice([0.0, -args[i], str(args[i]), "n/a", None])
        rows.append([args, compute_fallback_pnl_usd(*args)])
    return rows


# ── 2. the four readers on one seeded DB ─────────────────────────────────────
UNDECRYPTABLE = "@undecryptable"
K = {
    "bybit": ("BYK-AAAA-1111", "BYS-aaaa-1111"),
    "bingx": ("BXK-BBBB-2222", "BXS-bbbb-2222"),
    "binance": ("BNK-CCCC-3333", "BNS-cccc-3333"),
    "okx": ("OKK-DDDD-4444", "OKS-dddd-4444", "OK-pass#4444"),
}
PRO = {"sub_plan": "pro", "sub_status": "active", "sub_expires": NOW + 30 * D}
FREE = {"sub_plan": "free", "sub_status": "active", "sub_expires": 0.0}
ON = {"active": True}


def U(uid, username=None, fields=None, keys=None, raw=None, created=None):
    f = dict(ON)
    f.update(fields or {})
    r = dict(raw or {})
    r["created_at"] = created if created is not None else NOW - uid * 1000.0
    return {"user_id": uid, "username": username, "fields": f, "keys": keys or {}, "raw": r}


USERS = [
    U(501, "alice", {**PRO, "auto_trade": True, "trade_exchange": "bybit"}, {"bybit": K["bybit"]}),
    U(502, "bob", {**PRO, "auto_trade": True, "trade_exchange": "bingx"}, {"bingx": K["bingx"]}),
    U(503, "", {**PRO, "auto_trade": True, "trade_exchange": "binance", "lang": "en"}, {"binance": K["binance"]}),
    U(504, "dave", {**PRO, "auto_trade": True, "trade_exchange": "okx", "bybit_demo": True}, {"okx": K["okx"]}),
    U(505, "erin", {**PRO, "auto_trade": True, "trade_exchange": "okx"}, {"okx": (K["okx"][0], K["okx"][1], "")}),
    # exchange fallbacks: unknown / upper case / empty / padded names read the Bybit key
    U(506, None, {**PRO, "auto_trade": True, "trade_exchange": "kraken"}, {"bybit": K["bybit"]}),
    U(507, "gus", {**PRO, "auto_trade": True, "trade_exchange": "BINGX"}, {"bingx": K["bingx"]}),
    U(508, "hal", {**PRO, "auto_trade": True, "trade_exchange": "BINGX"}, {"bybit": K["bybit"], "bingx": K["bingx"]}),
    U(509, "ivy", {**PRO, "auto_trade": True, "trade_exchange": ""}, {"bybit": K["bybit"]}),
    U(510, "jon", {**PRO, "auto_trade": True, "trade_exchange": " okx"}, {"okx": K["okx"]}),
    # keys missing / empty / key-only / undecryptable / keys of another exchange
    U(511, "kim", {**PRO, "auto_trade": True, "trade_exchange": "bingx"}, {"bybit": K["bybit"]}),
    U(512, "lea", {**PRO, "auto_trade": True, "trade_exchange": "bybit"}, {}),
    U(513, "max", {**PRO, "auto_trade": True, "trade_exchange": "bybit"}, {"bybit": ("BYK-ONLY-5555", "")}),
    U(514, "ned", {**PRO, "auto_trade": True, "trade_exchange": "bingx"}, {"bingx": (UNDECRYPTABLE, K["bingx"][1])}),
    U(515, "oli", {**PRO, "auto_trade": True, "trade_exchange": "okx"}, {"okx": (K["okx"][0], UNDECRYPTABLE, K["okx"][2])}),
    U(516, "pam", {**PRO, "auto_trade": True, "trade_exchange": "binance"},
      {"bybit": K["bybit"], "bingx": K["bingx"], "binance": K["binance"], "okx": K["okx"]}),
    # auto_trade falsy / odd stored values (raw SQL: the dataclass would coerce them)
    U(517, "quinn", {**PRO, "trade_exchange": "bybit"}, {"bybit": K["bybit"]}, raw={"auto_trade": 0}),
    U(518, "ray", {**PRO, "trade_exchange": "bybit"}, {"bybit": K["bybit"]}, raw={"auto_trade": None}),
    U(519, "sam", {**PRO, "trade_exchange": "bybit"}, {"bybit": K["bybit"]}, raw={"auto_trade": ""}),
    U(520, "tia", {**PRO, "trade_exchange": "bybit"}, {"bybit": K["bybit"]}, raw={"auto_trade": "0"}),
    U(521, "uma", {**PRO, "trade_exchange": "bybit"}, {"bybit": K["bybit"]}, raw={"auto_trade": 0.0}),
    U(522, "vic", {**PRO, "trade_exchange": "bybit"}, {"bybit": K["bybit"]}, raw={"auto_trade": "false"}),
    U(523, "wes", {**PRO, "trade_exchange": "bybit"}, {"bybit": K["bybit"]}, raw={"auto_trade": 2}),
    U(524, "xia", {**PRO, "trade_exchange": "bybit"}, {"bybit": K["bybit"]}, raw={"auto_trade": " "}),
    # plan / status / expiry / strategy toggles (db_get_active_users WHERE)
    U(525, "yan", {**FREE, "auto_trade": True, "trade_exchange": "bybit"}, {"bybit": K["bybit"]}),
    U(526, "zed", {"sub_plan": "pro", "sub_status": "active", "sub_expires": NOW - 1.0, "auto_trade": True,
                   "trade_exchange": "bybit"}, {"bybit": K["bybit"]}),
    U(527, "abe", {"sub_plan": "pro", "sub_status": "trial", "sub_expires": NOW + 3600.0, "auto_trade": True,
                   "trade_exchange": "bybit"}, {"bybit": K["bybit"]}),
    U(528, "bea", {"sub_plan": "pro", "sub_status": "expired", "sub_expires": NOW + 3600.0, "auto_trade": True,
                   "trade_exchange": "bybit"}, {"bybit": K["bybit"]}),
    U(529, "cal", {"sub_plan": "elite", "sub_status": "active", "sub_expires": NOW + 3600.0, "auto_trade": True,
                   "trade_exchange": "bingx"}, {"bingx": K["bingx"]}),
    U(530, "dee", {**PRO, "auto_trade": True, "trade_exchange": "bybit", "active": False}, {"bybit": K["bybit"]}),
    U(531, "eve", {**PRO, "auto_trade": True, "trade_exchange": "bybit", "active": False, "smc_short_active": True},
      {"bybit": K["bybit"]}),
    U(532, "fay", {**PRO, "auto_trade": True, "trade_exchange": "bybit", "active": False, "vol_long_active": True},
      {"bybit": K["bybit"]}),
    U(533, "gil", {"sub_plan": "pro", "sub_status": "active", "sub_expires": NOW, "auto_trade": True,
                   "trade_exchange": "bybit"}, {"bybit": K["bybit"]}),
    U(534, "hub", {"sub_plan": "", "sub_status": "trial", "sub_expires": NOW + 5.0, "auto_trade": True,
                   "trade_exchange": "okx"}, {"okx": K["okx"]}),
    # created_at ties / username NULL (db_get_all_users ORDER BY created_at DESC)
    U(535, "ivo", {**FREE}, {}, created=NOW - 7 * D),
    U(536, None, {**FREE}, {}, raw={"username": None}, created=NOW - 7 * D),
    U(537, "kat", {**FREE}, {}, created=NOW - 7 * D),
    U(538, "lou", {**PRO, "auto_trade": True, "trade_exchange": "bybit"}, {"bybit": K["bybit"]}, created=NOW - 7 * D),
    # a plaintext key left from before encryption (db/core._decrypt_key returns it unchanged)
    U(539, "mia", {**PRO, "auto_trade": True, "trade_exchange": "bybit"}, {"bybit": K["bybit"]},
      raw={"bybit_api_key": "PLAIN-OLD-KEY-6666"}),
]
SITE_PLAIN = {539: {"bybit": ("PLAIN-OLD-KEY-6666", K["bybit"][1])}}   # the same key as the site stores it
UNDECRYPTABLE_TOKEN = "gAAAAA" + "B" * 120                            # Fernet-shaped, not decryptable


def trade(tid, uid, oid, created, result="", sym="BTCUSDT", **kw):
    r = {"trade_id": tid, "user_id": uid, "symbol": sym, "direction": kw.pop("direction", "LONG"), "entry": 100.0 + (sum(map(ord, tid)) % 7),
         "sl": 95.0, "tp1": 105.0, "tp2": 110.0, "tp3": 115.0, "created_at": created, "result": result, "order_id": oid}
    r.update(kw)
    return r


def build_trades():
    rnd = random.Random(15015)
    rows = []
    uids = [501, 502, 503, 504, 516, 538]
    oids = [f"{rnd.randint(1, 10 ** 9):09d}" for _ in range(495)] + ["000000042"] * 3 + ["7,8", "a1", "Z"]
    rnd.shuffle(oids)
    for i, oid in enumerate(oids):           # 501 open exchange rows (one more than LIMIT 500)
        rows.append(trade(f"o{i:03d}", uids[i % len(uids)], oid, NOW - rnd.randint(60, 9 * 86400),
                          sym=rnd.choice(["BTCUSDT", "ETHUSDT", "BTC-USDT", "SOL-USDT-SWAP"])))
    stale = NOW - 72 * 3600
    rows += [
        # not open: no order / closed / result NULL / order NULL
        trade("n-signal", 501, "", NOW - 5 * D),
        trade("n-closed", 501, "111", NOW - 5 * D, result="TP1"),
        trade("n-skip", 502, "112", NOW - 5 * D, result="SKIP"),
        trade("n-null-result", 502, "113", NOW - 5 * D, result=None),
        trade("n-null-oid", 503, None, NOW - 5 * D),
        trade("n-null-both", 503, None, NOW - 6 * D, result=None),
        trade("n-young-signal", 504, "", NOW - 3600.0),
        trade("n-young-null", 504, None, NOW - 7200.0, result=None),
        # FIX-5 edges: created_at exactly at / just before the cutoff
        trade("s-edge", 501, "", stale),
        trade("s-edge-minus", 501, "", stale - 0.001),
        trade("s-old-null-result", 502, "", NOW - 30 * D, result=None),
        trade("s-old-closed", 502, "", NOW - 30 * D, result="SL"),
        # [GHOST-LIVE-TRADES 2026-10]: exchange rows older than 72 h — never stale
        trade("g-live-4d", 503, "998877", NOW - 4 * D),
        trade("g-live-40d", 503, "998878", NOW - 40 * D),
        trade("g-live-null-result", 504, "998879", NOW - 40 * D, result=None),
    ]
    return rows


async def readers():
    import database as db
    from user_manager import UserManager
    await H.init_db()
    F = H.Fakes()
    H.CLK.set_wall(NOW - 3600.0)
    await H.seed_users(USERS, F)
    for u in USERS:                              # Fernet-shaped tokens that cannot be decrypted
        for ex, kv in (u["keys"] or {}).items():
            if kv[0] == UNDECRYPTABLE:
                H.sql(f"UPDATE users SET {ex}_api_key=? WHERE user_id=?", (UNDECRYPTABLE_TOKEN, u["user_id"]))
            if kv[1] == UNDECRYPTABLE:
                H.sql(f"UPDATE users SET {ex}_api_secret=? WHERE user_id=?", (UNDECRYPTABLE_TOKEN, u["user_id"]))
    trades = build_trades()
    H.seed_trades(trades)
    H.CLK.set_wall(NOW)
    users_raw = H.sql_rows("SELECT * FROM users ORDER BY user_id")
    key_cols = [f"{ex}_api_{p}" for ex in ("bybit", "bingx", "binance", "okx") for p in ("key", "secret")] + ["okx_passphrase"]
    for r in users_raw:
        for c in key_cols:
            r.pop(c, None)
    H.LOGS.take()
    logs = {}

    def errs():   # the readers' own lines (CHM.DB: _decrypt_key, the active-users retry); not import-time config noise
        return [[ln["level"], ln["msg"]] for ln in H.LOGS.take()
                if ln["logger"] == "CHM.DB" and ln["level"] in ("WARNING", "ERROR", "CRITICAL")]
    open_all = await db.db_get_open_trades_all()
    logs["open_all"] = errs()
    cutoffs = [NOW - 72 * 3600, NOW - 72 * 3600 + 0.0005, NOW - 10 * D]
    stale = [[c, await db.db_get_all_stale_open_trades(c)] for c in cutoffs]
    logs["stale"] = errs()
    one = {}
    logs["get_user"] = {}
    for u in USERS + [{"user_id": 999999}]:
        one[str(u["user_id"])] = await db.db_get_user(u["user_id"])
        logs["get_user"][str(u["user_id"])] = errs()
    all_users = await db.db_get_all_users()
    logs["all_users"] = errs()
    active = [dataclasses.asdict(u) for u in await UserManager().get_active_auto_trade_users()]
    logs["active"] = errs()
    plans = {
        "open_all": H.explain("SELECT * FROM trades WHERE result='' AND order_id!='' LIMIT 500"),
        "stale": H.explain("SELECT * FROM trades WHERE (result = '' OR result IS NULL) AND created_at < ?   AND "
                           "(order_id = '' OR order_id IS NULL)", (NOW,)),
        "all_users": H.explain("SELECT * FROM users ORDER BY created_at DESC"),
        "active_users": H.explain("""SELECT * FROM users
                       WHERE (sub_plan='free'
                              OR (sub_status IN ('trial','active')
                                  AND sub_expires > ?))
                       AND (active=1 OR long_active=1 OR short_active=1
                            OR smc_long_active=1 OR smc_short_active=1
                            OR vol_long_active=1 OR vol_short_active=1)""", (NOW,)),
        "get_user": H.explain("SELECT * FROM users WHERE user_id=?", (1,)),
    }
    return {
        "now": NOW, "users": USERS, "site_plain": {str(k): v for k, v in SITE_PLAIN.items()}, "undecryptable": UNDECRYPTABLE,
        "users_raw": users_raw, "trades": trades,
        "open_all": open_all, "stale": stale, "get_user": one, "all_users": all_users, "active": active, "plans": plans,
        "logs": logs,
    }


# ── 2b. db_get_active_users' retry back-off is a cancellation point ─────────────
ACTIVE_RETRY_CASES = [   # (mode, at): the read bare, under wait_for(at), as a task cancelled at `at` (no ties
    ("plain", None),     # with the 0 / 1 / 3 s queries — PLAN §1.4 / §1.5: an in-pass sleep cancels at its await)
    ("wait_for", 0.5), ("cancel", 0.5), ("wait_for", 2.5), ("cancel", 1.5), ("wait_for", 3.5), ("cancel", 2.25),
]


async def active_retry():
    """user_manager.get_active_auto_trade_users with db_get_active_users' `_read_conn` raising
    'database is locked' on every attempt: the 3 queries (0 s, 1 s, 3 s), the retry WARNINGs, and what a
    wait_for timeout / task.cancel() during the 1 s / 2 s back-off does (TimeoutError / CancelledError at
    that instant, no further query)."""
    import asyncio
    import contextlib
    import sqlite3
    import db.users as dbu
    from user_manager import UserManager
    queries: list = []

    @contextlib.asynccontextmanager
    async def locked_conn():
        queries.append(H.CLK.mono)
        raise sqlite3.OperationalError("database is locked")     # aiosqlite's SQLITE_BUSY
        yield None   # noqa: unreachable — the generator shape of an async context manager

    real = dbu._read_conn
    dbu._read_conn = locked_conn
    out = []
    try:
        for mode, at in ACTIVE_RETRY_CASES:
            queries.clear()
            H.LOGS.take()
            t0 = H.CLK.mono
            um = UserManager()
            try:
                if mode == "plain":
                    await um.get_active_auto_trade_users()
                elif mode == "wait_for":
                    await asyncio.wait_for(um.get_active_auto_trade_users(), at)
                else:
                    task = asyncio.get_running_loop().create_task(um.get_active_auto_trade_users(), name="be_pass")
                    await asyncio.sleep(at)
                    task.cancel()
                    await task
                outcome = ["ok"]
            except asyncio.CancelledError:
                outcome = ["CancelledError"]
            except asyncio.TimeoutError:
                outcome = ["TimeoutError"]
            except Exception as e:  # noqa: BLE001
                outcome = [type(e).__name__, str(e)]
            elapsed = H.CLK.mono - t0
            await asyncio.sleep(10)          # nothing more happens after the outcome (no late query or log line)
            out.append({"mode": mode, "at": at, "outcome": outcome, "elapsed": elapsed, "queries": [q - t0 for q in queries],
                        "logs": [[ln["level"], ln["msg"]] for ln in H.LOGS.take()
                                 if ln["logger"] == "CHM.DB" and ln["level"] in ("WARNING", "ERROR", "CRITICAL")]})
    finally:
        dbu._read_conn = real
    return out


# ── 3. alert_be_monitor_crash ────────────────────────────────────────────────
async def alerts():
    import admin_alerts
    sent: list = []
    bot = H.RecBot(sent)
    long_err = ("Ж" * 150) + ("<&>\"'" * 30) + ("😀" * 60) + ("x" * 200)
    steps = [
        ("first", 5, None, 0.0),
        ("dedup_within_6h", 6, "RuntimeError: boom", 3600.0),
        ("dedup_edge", 7, "x", 6 * 3600 - 3600.0 - 0.5),
        ("after_6h", 8, "", 1.0),
        ("html", 9, "<b>bad</b> & 'quotes' \"dq\"", 6 * 3600.0 + 1),
        ("long", 10, long_err, 6 * 3600.0 + 1),
        ("astral_cut", 5, ("a" * 399) + "😀😀", 6 * 3600.0 + 1),
        ("timeout_text", 5, "_check_breakevens timeout 32.0s", 6 * 3600.0 + 1),
        ("no_bot", 5, "zzz", 6 * 3600.0 + 1),
    ]
    out = []
    for name, streak, err, dt in steps:
        H.CLK.advance(dt)
        n0 = len(sent)
        b = None if name == "no_bot" else bot
        if err is None:
            await admin_alerts.alert_be_monitor_crash(b, streak)
        else:
            await admin_alerts.alert_be_monitor_crash(b, streak, err)
        kv = H.sql_rows("SELECT value FROM kv WHERE key='adm_alert_be_monitor_crash_global'")
        out.append({"name": name, "streak": streak, "last_error": err, "wall": H.CLK.wall, "sent": sent[n0:],
                    "kv": kv[0]["value"] if kv else None})
    return {"steps": out, "ttl": admin_alerts._ALERT_DEDUP_TTL, "default_ttl": admin_alerts._DEFAULT_TTL}


# ── 4. i18n round trip ───────────────────────────────────────────────────────
M15_KEYS = [
    "limit_order_cancelled", "trade_auto_closed",
    "trade_closed_tp1", "trade_closed_tp2", "trade_closed_tp3", "trade_closed_sl", "trade_closed_be",
    "trade_closed_trail_profit", "trade_closed_trail_loss", "trade_closed_trail_be",
    "trade_closed_manual_profit", "trade_closed_manual_loss", "trade_closed_manual_be",
    "trade_closed_auto_profit", "trade_closed_auto_loss", "trade_closed_auto_be", "trade_closed_generic",
    "trade_balance", "trailing_stop_updated", "trailing_level_be", "trailing_level_plus_r",
    "trailing_sl_failed", "tp_placement_failed_warning",
]
# [kwargs, float keys] as the call sites pass them (scanner_mid.py _check_breakevens / _notify_trailing_fail)
KW = {
    "symbol": ({"symbol": "BTC"}, []),
    "trade_balance": ({"balance": 1234.5678}, ["balance"]),
    "trailing_stop_updated": ({"symbol": "ETH", "direction": "LONG", "new_sl": "2051.5", "level_text": "+1R",
                               "current_rr": 2.25}, ["current_rr"]),
    "trailing_level_plus_r": ({"n": 2}, []),
    "trailing_sl_failed": ({"symbol": "SOL", "level": 1}, []),
    "tp_placement_failed_warning": ({"symbol": "1000PEPE", "retries": 10}, []),
}


def i18n_rows():
    from i18n import t
    rows = []

    def add(key, lang, kw, fk):
        rows.append([key, lang, kw, fk, t(key, lang, **kw)])
    for key in M15_KEYS:
        if key in KW:
            kw, fk = KW[key]
        elif key in ("trailing_level_be",):
            kw, fk = {}, []
        else:
            kw, fk = KW["symbol"]
        for lang in ("ru", "en", "de", "", None):
            add(key, lang, kw, fk)
        add(key, "en", {}, [])                                   # no kwargs: the raw text
    # formatting edge cases (the bot returns the unformatted text on any format error)
    add("trade_balance", "ru", {"balance": 0.005}, ["balance"])
    add("trade_balance", "en", {"balance": -2.0}, ["balance"])
    add("trade_balance", "en", {"balance": 1e21}, ["balance"])
    add("trade_balance", "ru", {"balance": 7}, [])
    add("trade_balance", "ru", {"balance": "12.5"}, [])          # ValueError → raw text
    add("trade_balance", "en", {"balance": None}, [])            # TypeError → raw text
    add("trade_balance", "en", {"other": 1}, [])                 # KeyError → raw text
    add("trailing_stop_updated", "ru", {"symbol": "X", "direction": "SHORT", "new_sl": "1e-05", "level_text": "безубыток",
                                        "current_rr": 0.05}, ["current_rr"])
    add("trailing_stop_updated", "en", {"symbol": "X", "direction": "SHORT", "new_sl": "3", "level_text": "+2R",
                                        "current_rr": 1.25}, ["current_rr"])
    add("trailing_stop_updated", "en", {"symbol": "X", "direction": "SHORT", "new_sl": "3", "level_text": "+2R",
                                        "current_rr": 3}, [])
    add("trailing_level_plus_r", "en", {"n": 0}, [])
    add("tp_placement_failed_warning", "ru", {"symbol": "<b>&</b>", "retries": 3, "extra": "ignored"}, [])
    add("trade_closed_sl", "en", {"symbol": "ÄÖÜ 😀"}, [])
    add("no_such_key_m15", "ru", {"symbol": "X"}, [])
    return rows


# ── 5. trader signatures ─────────────────────────────────────────────────────
M15_FNS = ["get_positions", "get_open_orders", "get_algo_sl_orders", "cancel_order", "cancel_all_orders", "cancel_tp_orders_only",
           "cancel_tp_orders", "get_closed_pnl", "get_execution_exit_price", "get_balance", "set_trailing_sl",
           "place_sl_tp_for_position", "place_tp_orders", "close_position", "close_position_partial", "get_funding_rate",
           "is_delisted"]


def signatures():
    import bybit_trader
    import bingx_trader
    import binance_trader
    import okx_trader
    out = {}
    for ex, mod in (("bybit", bybit_trader), ("bingx", bingx_trader), ("binance", binance_trader), ("okx", okx_trader)):
        out[ex] = {}
        for fn in M15_FNS:
            f = getattr(mod, fn, None)
            if f is None or not callable(f):
                continue
            out[ex][fn] = {"sig": H.sig_json(inspect.signature(f)), "async": inspect.iscoroutinefunction(inspect.unwrap(f))}
    return out


async def amain():
    """One event loop for everything (the bot's aiosqlite connections belong to the loop that made them)."""
    fixture = {"python": sys.version.split()[0], "bot_head": "1a47ffc", "fallback_pnl": fallback_rows()}
    fixture["readers"] = await readers()
    fixture["alert"] = await alerts()
    fixture["i18n"] = {"keys": M15_KEYS, "rows": i18n_rows()}
    fixture["sigs"] = signatures()               # before the self-test installs its fakes
    fixture["harness"] = await H.self_test_async()
    fixture["active_retry"] = await active_retry()   # last: its virtual sleeps shift no earlier section's instants
    return fixture


def main():
    fixture = H.run(amain)
    n = H.write_fixture(fixture, OUT)
    print(f"m15 units: {len(fixture['fallback_pnl'])} pnl rows, {len(fixture['readers']['open_all'])} open rows, "
          f"{len(fixture['readers']['active'])} active users, {len(fixture['i18n']['rows'])} i18n rows, "
          f"{len(fixture['harness']['semaphores'])} semaphore traces → {OUT} ({n} bytes json)")


try:
    main()
    H.finish()
except BaseException:  # noqa: BLE001 — some bot module replaces sys.excepthook; print it here
    import traceback
    traceback.print_exc()
    sys.stderr.flush()
    try:
        H.finish()
    except BaseException as e:  # noqa: BLE001
        print(e, file=sys.stderr)
    os._exit(1)
sys.stdout.flush()
os._exit(0)
