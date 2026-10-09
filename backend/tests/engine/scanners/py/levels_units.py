"""levels_units.py — unit-level differential vectors of the bot's LEVELS scanner (scanner_mid.py,
telegram_safe.py) for backend/tests/engine/scanners/levels_units.test.js.

Everything runs the REAL bot code with the levels_fakes.py doubles; the asyncio module seen by
scanner_mid / telegram_safe is swapped for a proxy whose sleep() records the delay instead of
waiting (and stops a loop by raising CancelledError), so the infinite loops are observable:

  build_jobs     MidScanner._build_jobs over users × now × last_scan
  cfg_to_ind     _cfg_to_ind(get_long_cfg(), high_wr) for those users
  notify         _notify_expired(user): paid / already notified / free / blocked bot
  sub_check      _sub_check_loop: 4 iterations (expiry crossing, an all_users() error)
  ws_trigger     _on_ws_bar_close sequence (TF match, BOTH, throttle 1/5 min, no-op TFs)
  scan_loop      _scan_loop over stub cycles: ok / slow (> 120 s) / error / timeout
  fetch          _load_tf_candles with CACHE_FIRST_MODE off / shadow (60 s aggregate) / enforce
  warmup         _warmup_cache with a candle_store that has data (the set_candles quirk)
  safe_send      telegram_safe.safe_send_message over scripted aiogram errors + a long text
  split          _split_for_telegram on emoji-heavy texts
  on_demand      analyze_on_demand / analyze_on_demand_lang (symbol normalisation, no data)

Run (bot checkout is read-only):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311>/bin/python levels_units.py [OUT]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import asyncio
import dataclasses
import os
import sys
import types
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import levels_fakes as F  # noqa: E402

OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "..", "levels_fixtures", "units.json.gz")

import cache  # noqa: E402
import database  # noqa: E402
import metrics  # noqa: E402
import signal_freshness  # noqa: E402
import signal_registry  # noqa: E402
import scanner_mid  # noqa: E402
import telegram_safe  # noqa: E402
import user_manager  # noqa: E402
from config import Config  # noqa: E402
from user_manager import UserManager, UserSettings  # noqa: E402

T = lambda s: datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()  # noqa: E731
REAL_ASYNCIO = asyncio
T0 = T("2025-12-31T14:00:20")


class Stop(Exception):
    pass


class AioProxy:
    """The asyncio module as a bot module sees it, with a recording sleep()."""

    def __init__(self, on_sleep):
        self.on_sleep = on_sleep
        self.timeout_next = False

    def __getattr__(self, name):
        return getattr(REAL_ASYNCIO, name)

    async def sleep(self, delay, *a, **k):
        self.on_sleep(delay)
        await REAL_ASYNCIO.sleep(0)

    async def wait_for(self, aw, timeout=None):
        if self.timeout_next:
            self.timeout_next = False
            if asyncio.iscoroutine(aw):
                aw.close()
            raise REAL_ASYNCIO.TimeoutError()
        return await REAL_ASYNCIO.wait_for(aw, timeout)


class TimeProxy:
    def __getattr__(self, name):
        return getattr(F._time, name)

    @staticmethod
    def time():
        return F.CLK.t

    @staticmethod
    def monotonic():
        return F.CLK.t


PRO = dict(sub_plan="pro", sub_status="active", sub_expires=T("2026-02-01T00:00:00"))
USERS = [
    (3001, dict(PRO, strategy="LEVELS", long_active=True, short_active=True, long_tf="15m", short_tf="1h",
                long_interval=900, short_interval=3600, lang="ru")),
    (3002, dict(PRO, strategy="LEVELS", active=True, scan_mode="both", timeframe="1h", scan_interval=1800,
                long_active=True, long_tf="1h", long_interval=1800, lang="en")),
    (3003, dict(PRO, strategy="SMC", extra_strategies="LEVELS", long_active=True, long_tf="4h", long_interval=3600,
                high_wr_mode=True, lang="ru",
                long_cfg='{"min_rr": 1.5, "pivot_strength": 5, "use_volume": false, "_sparse": true}')),
    (3004, dict(PRO, strategy="SMC", long_active=True, long_tf="15m", long_interval=900, lang="ru")),
    (3005, dict(sub_plan="free", strategy="LEVELS", short_active=True, short_tf="15m", short_interval=900,
                lang="en", min_quality=1, use_htf=True)),
    (3006, dict(PRO, strategy="LEVELS", active=True, scan_mode="long", long_active=False, timeframe="15m",
                lang="ru")),
    # expiry probes
    (3101, dict(sub_plan="pro", sub_status="active", sub_expires=T0 - 10, strategy="LEVELS", long_active=True,
                short_active=True, lang="ru")),
    (3102, dict(sub_plan="pro", sub_status="trial", sub_expires=T0 - 10, expired_notified=True, strategy="LEVELS",
                long_active=True, lang="ru")),
    (3103, dict(sub_plan="free", sub_status="active", sub_expires=0, strategy="LEVELS", long_active=True)),
    (3104, dict(sub_plan="pro", sub_status="active", sub_expires=T0 + 200, strategy="LEVELS", long_active=True,
                lang="en")),
    (3105, dict(sub_plan="pro", sub_status="expired", sub_expires=T0 - 99999, strategy="LEVELS")),
    (3106, dict(sub_plan="pro", sub_status="active", sub_expires=T0 - 5, strategy="LEVELS", short_active=True)),
]
CT_USERS = [   # the scanner-level counter-trend gate of _send (auto-trade users, regime trending_down, LONG)
    (3201, dict(PRO, strategy="LEVELS", long_active=True, long_tf="15m", auto_trade=True, trade_exchange="bybit",
                allow_counter_trend=True, levels_counter_trend_min_quality=0, lang="ru")),
    (3202, dict(PRO, strategy="LEVELS", long_active=True, long_tf="15m", auto_trade=True, trade_exchange="bybit",
                allow_counter_trend=True, levels_counter_trend_min_quality=3, lang="en")),
    (3203, dict(PRO, strategy="LEVELS", long_active=True, long_tf="15m", auto_trade=True, trade_exchange="bybit",
                allow_counter_trend=False, lang="ru")),
    (3204, dict(PRO, strategy="LEVELS", long_active=True, long_tf="15m", auto_trade=True, trade_exchange="bybit",
                allow_counter_trend=False, filters_all_off=True, lang="ru", signal_format="lite")),
]
USERS += CT_USERS
CT_KEYS = {uid: ("bybit", f"by-key-{uid}", f"by-secret-{uid}") for uid, _ in CT_USERS}
BOT_FAIL = {3106}
SYMBOLS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SYNLV07-USDT-SWAP", "PEPEVL07-USDT-SWAP", "DOGEVL08-USDT-SWAP",
           "SYNUP04-USDT-SWAP", "SYNRG01-USDT-SWAP", "SYNDN02-USDT-SWAP"]


async def main() -> int:
    snap_before = F.tree_snapshot()
    cap = F.capture_logs()
    F.CLK.t = T0
    await database.init_db(os.environ["DB_PATH"])
    cache.init_cache(max_keys=Config.CACHE_MAX_KEYS)
    signal_registry._PERSIST_PATH = os.path.join(F.TMP, "signal_registry.json")
    metric_calls = []

    async def fake_record(name, value=1.0, tags=None, **kw):
        metric_calls.append([name, value, dict(tags or {})])
    metrics.record = fake_record

    um = UserManager()
    for uid, fields in USERS:
        u = UserSettings(user_id=uid)
        for k, v in fields.items():
            setattr(u, k, v)
        if uid in CT_KEYS:
            ex, key, sec = CT_KEYS[uid]
            setattr(u, f"{ex}_api_key", key)
            setattr(u, f"{ex}_api_secret", sec)
        await um.save(u)
    init_rows = F.sqlite_rows("SELECT * FROM users ORDER BY user_id")
    for r in init_rows:
        for c in [c for c in r if c.endswith("_api_key") or c.endswith("_api_secret") or c.endswith("_passphrase")]:
            r[c] = ""
    volumes = {s: 1e9 / (1 + i) for i, s in enumerate(SYMBOLS)}
    fetcher = F.FakeFetcher(volumes, {})
    bot = F.FakeBot()
    bot.fail = set(BOT_FAIL)
    scanner = scanner_mid.MidScanner(Config, bot, um)
    scanner.fetcher = fetcher
    out: dict = {}

    def logs_since(n):
        return cap.lines[n:]

    # ── build_jobs / cfg_to_ind ───────────────────────────────────────────
    users = {uid: await um.get(uid) for uid, _ in USERS}
    bj = []
    for uid in (3001, 3002, 3003, 3004, 3005, 3006):
        u = users[uid]
        for now, last in ((T0, {}), (T0, {f"{uid}_LONG": T0 - 900, f"{uid}_SHORT": T0 - 899, f"{uid}_BOTH": T0 - 1800}),
                          (T0, {f"{uid}_LONG": T0 - 100, f"{uid}_SHORT": T0 - 4000, f"{uid}_BOTH": 0.0})):
            jobs = scanner_mid.MidScanner._build_jobs(u, now, dict(last))
            bj.append({"uid": uid, "now": now, "last": last,
                       "jobs": [[j.direction, j.tf, j.interval, j.job_key, dataclasses.asdict(j.cfg)] for j in jobs]})
    out["build_jobs"] = bj
    out["cfg_to_ind"] = [{"uid": uid, "high_wr": hw,
                          "ind": dataclasses.asdict(scanner_mid._cfg_to_ind(users[uid].get_long_cfg(), high_wr_mode=hw))}
                         for uid in (3001, 3003, 3005) for hw in (False, True)]

    # ── _notify_expired ───────────────────────────────────────────────────
    n0, s0 = len(cap.lines), len(bot.sent)
    for uid in (3101, 3102, 3103, 3106):
        for d in ("LONG", "SHORT", "BOTH"):
            scanner._last_scan[f"{uid}_{d}"] = T0 - 50
    for uid in (3101, 3102, 3103, 3106):
        await scanner._notify_expired(await um.get(uid))
    await F.drain()
    out["notify"] = {"sent": bot.sent[s0:], "logs": logs_since(n0), "last_scan": dict(scanner._last_scan),
                     "users": F.users_snapshot()}
    scanner._last_scan.clear()

    # ── _sub_check_loop ───────────────────────────────────────────────────
    # restore the expiry probes, then run the loop
    for uid, fields in USERS:
        if 3100 <= uid < 3200:
            u = UserSettings(user_id=uid)
            for k, v in fields.items():
                setattr(u, k, v)
            await um.save(u)
    user_manager._all_users_cache = None
    user_manager._active_users_cache = None
    sleeps = []
    real_all = um.all_users
    calls = {"n": 0}

    async def flaky_all_users():
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("database is locked")
        return await real_all()
    um.all_users = flaky_all_users

    def on_sleep_sub(d):
        sleeps.append(d)
        F.CLK.t += d
        if len(sleeps) >= 5:
            raise REAL_ASYNCIO.CancelledError()
    scanner_mid.asyncio = AioProxy(on_sleep_sub)
    n0, s0 = len(cap.lines), len(bot.sent)
    F.CLK.t = T0 - 60
    try:
        await scanner._sub_check_loop()
    except REAL_ASYNCIO.CancelledError:
        pass
    scanner_mid.asyncio = REAL_ASYNCIO
    um.all_users = real_all
    await F.drain()
    out["sub_check"] = {"start": T0 - 60, "sleeps": sleeps, "sent": bot.sent[s0:], "logs": logs_since(n0),
                        "users": F.users_snapshot()}

    # ── _on_ws_bar_close ──────────────────────────────────────────────────
    F.CLK.t = T0 + 3600
    user_manager._all_users_cache = None
    user_manager._active_users_cache = None
    keys = {f"{uid}_{d}": T0 for uid in (3001, 3002, 3003, 3004, 3005, 3006) for d in ("LONG", "SHORT", "BOTH")}
    del keys["3001_BOTH"]
    steps = [[0, "BTC-USDT-SWAP", "15m"], [100, "BTC-USDT-SWAP", "15m"], [120, "ETH-USDT-SWAP", "1H"],
             [130, "BTC-USDT-SWAP", ""], [140, "BTC-USDT-SWAP", "4H"], [450, "BTC-USDT-SWAP", "15m"],
             [460, "BTC-USDT-SWAP", "1D"]]
    ws = []
    for dt, inst, tf in steps:
        F.CLK.t = T0 + 3600 + dt
        scanner._last_scan.clear()
        scanner._last_scan.update(keys)
        n0 = len(cap.lines)
        await scanner._on_ws_bar_close(inst, tf)
        ws.append({"t": F.CLK.t, "inst": inst, "tf": tf, "last_scan": dict(scanner._last_scan), "logs": logs_since(n0),
                   "trig": dict(getattr(scanner, "_ws_trig_last", {}))})
    out["ws_trigger"] = {"keys": keys, "steps": ws}
    scanner._last_scan.clear()

    # ── _scan_loop ────────────────────────────────────────────────────────
    plan = ["ok", "slow", "raise", "timeout", "ok"]
    state = {"i": 0}
    sl_sleeps = []
    heartbeats = []
    scanner._health = types.SimpleNamespace(heartbeat=lambda name: heartbeats.append(name))
    real_cycle = scanner._cycle

    async def stub_cycle():
        step = plan[state["i"]]
        state["i"] += 1
        if step == "ok":
            F.CLK.t += 3.0
        elif step == "slow":
            F.CLK.t += 130.5
        elif step == "raise":
            F.CLK.t += 1.0
            raise RuntimeError("database is locked")

    def on_sleep_scan(d):
        sl_sleeps.append(d)
        F.CLK.t += d
        if len(sl_sleeps) >= len(plan):
            raise REAL_ASYNCIO.CancelledError()

    proxy = AioProxy(on_sleep_scan)

    scanner._cycle = stub_cycle

    async def wait_for_hook(aw, timeout=None):
        if state["i"] < len(plan) and plan[state["i"]] == "timeout":
            state["i"] += 1
            F.CLK.t += 2.0
            if asyncio.iscoroutine(aw):
                aw.close()
            raise REAL_ASYNCIO.TimeoutError()
        return await REAL_ASYNCIO.wait_for(aw, timeout)
    proxy.wait_for = wait_for_hook
    scanner_mid.asyncio = proxy
    scanner_mid.time = TimeProxy()
    signal_freshness._cycle_ema.clear()
    scanner._perf["users"] = 7
    scanner._perf["api_calls"] = 21
    n0, m0 = len(cap.lines), len(metric_calls)
    F.CLK.t = T0 + 7200
    t_start = F.CLK.t
    try:
        await scanner._scan_loop()
    except REAL_ASYNCIO.CancelledError:
        pass
    scanner_mid.asyncio = REAL_ASYNCIO
    scanner_mid.time = F._time
    scanner._cycle = real_cycle
    out["scan_loop"] = {"start": t_start, "plan": plan, "sleeps": sl_sleeps, "heartbeats": heartbeats,
                        "metrics": metric_calls[m0:], "logs": logs_since(n0),
                        "freshness_ema": dict(signal_freshness._cycle_ema)}

    # ── _fetch / _load_tf_candles: CACHE_FIRST_MODE ───────────────────────
    fetch = []
    F.CLK.t = T0 + 10000
    cache.init_cache(max_keys=Config.CACHE_MAX_KEYS)
    df = F.frame_at("BTC-USDT-SWAP", "15m", F.CLK.t, 300)
    await cache.set_candles("BTC-USDT-SWAP", "15m", df, Config.CACHE_TTL)
    scanner_mid._SHADOW_MISS_LEVELS = 0
    scanner_mid._SHADOW_LAST_LOG_LEVELS = 0.0
    for mode, dt in (("off", 0), ("shadow", 10), ("shadow", 20), ("shadow", 90), ("enforce", 100)):
        F.CLK.t = T0 + 10000 + dt
        os.environ["CACHE_FIRST_MODE"] = mode
        perf0 = {k: scanner._perf.get(k, 0) for k in ("cache_first_skip", "cache_first_shadow", "cache_hits_after_wait",
                                                       "api_calls", "api_calls_total")}
        n0, r0 = len(cap.lines), len(fetcher.calls)
        tf = "1h" if mode == "off" else ("4h" if dt == 10 else ("1D" if dt == 20 else ("15m" if dt == 90 else "1h")))
        res = await scanner._load_tf_candles(tf, SYMBOLS[:4] + ["NOPE-USDT-SWAP"])
        fetch.append({"mode": mode, "t": F.CLK.t, "tf": tf, "got": sorted(res.keys()),
                      "rest": fetcher.calls[r0:], "logs": logs_since(n0), "perf0": perf0,
                      "perf": {k: scanner._perf.get(k, 0) for k in perf0},
                      "shadow": [scanner_mid._SHADOW_MISS_LEVELS, scanner_mid._SHADOW_LAST_LOG_LEVELS]})
    os.environ.pop("CACHE_FIRST_MODE", None)
    out["fetch"] = fetch

    # ── _warmup_cache (candle_store has data → the set_candles quirk) ─────
    cache.init_cache(max_keys=Config.CACHE_MAX_KEYS)
    F.CLK.t = T0 + 20000
    store_calls = []

    async def ensure_candles(sym, tf, days, loader):
        store_calls.append([sym, tf, days])
        return F.frame_at(sym, tf, F.CLK.t, 300) if (len(store_calls) % 3) else None

    class HistoryLoader:
        closed = 0

        async def close(self):
            HistoryLoader.closed += 1
    saved_mods = {m: sys.modules.get(m) for m in ("candle_store", "backtest")}
    sys.modules["candle_store"] = types.SimpleNamespace(ensure_candles=ensure_candles)
    sys.modules["backtest"] = types.SimpleNamespace(HistoryLoader=HistoryLoader)
    wu_sleeps = []
    scanner_mid.asyncio = AioProxy(lambda d: wu_sleeps.append(d))
    n0, r0 = len(cap.lines), len(fetcher.calls)
    await scanner._warmup_cache()
    scanner_mid.asyncio = REAL_ASYNCIO
    for m, v in saved_mods.items():
        if v is None:
            sys.modules.pop(m, None)
        else:
            sys.modules[m] = v
    out["warmup"] = {"t": F.CLK.t, "sleeps": wu_sleeps, "store_calls": store_calls, "closed": HistoryLoader.closed,
                     "rest": fetcher.calls[r0:], "logs": logs_since(n0),
                     "cache_keys": list(cache._candle_cache._data.keys())}

    # ── telegram_safe.safe_send_message ───────────────────────────────────
    from aiogram.exceptions import (TelegramRetryAfter, TelegramNetworkError, TelegramBadRequest,
                                    TelegramForbiddenError)
    from aiogram.methods import SendMessage
    m = SendMessage(chat_id=1, text="x")

    def mk(kind):
        if kind == "retry":
            return TelegramRetryAfter(method=m, message="Too Many Requests: retry after 7", retry_after=7)
        if kind == "net":
            return TelegramNetworkError(method=m, message="timeout")
        if kind == "bad":
            return TelegramBadRequest(method=m, message="Bad Request: can't parse entities")
        if kind == "forbidden":
            return TelegramForbiddenError(method=m, message="Forbidden: bot was blocked by the user")
        if kind == "value":
            return ValueError("weird")
        return None

    class ScriptBot:
        def __init__(self, script):
            self.script = list(script)
            self.calls = []
            self.next_id = 7000

        async def send_message(self, chat_id, text, **kw):
            self.calls.append({"uid": chat_id, "text": text, "kw": sorted(kw.keys()),
                               "kb": F.kb_dump(kw.get("reply_markup"))})
            kind = self.script.pop(0) if self.script else "ok"
            e = mk(kind)
            if e is not None:
                raise e
            self.next_id += 1
            return types.SimpleNamespace(message_id=self.next_id)

    long_text = "\n".join(f"🟢 строка {i} — " + "📈" * (i % 7) + "x" * (40 + i % 13) for i in range(160))
    one_line = "🔴" * 4100
    cases = [
        ["ok"], ["retry", "ok"], ["net", "net", "ok"], ["net", "net", "net"], ["forbidden"], ["bad"], ["value"],
        ["retry", "retry", "retry"], ["net", "ok"],
    ]
    ss = []
    for script in cases:
        sbot = ScriptBot(script)
        sl = []
        telegram_safe.asyncio = AioProxy(lambda d, sl=sl: sl.append(d))
        sent_ids = []
        n0 = len(cap.lines)
        ok = await telegram_safe.safe_send_message(
            sbot, 42, "<b>hi</b>", parse_mode="HTML", protect_content=True,
            on_sent=lambda msg: sent_ids.append(msg.message_id), disable_notification=(script[0] == "net"))
        ss.append({"script": script, "ok": ok, "calls": sbot.calls, "sleeps": sl, "logs": logs_since(n0),
                   "on_sent": sent_ids})
    for text, script in ((long_text, ["ok"] * 5), (one_line, ["ok", "forbidden"]), ("", ["ok"])):
        sbot = ScriptBot(script)
        sl = []
        telegram_safe.asyncio = AioProxy(lambda d, sl=sl: sl.append(d))
        sent_ids = []
        n0 = len(cap.lines)
        ok = await telegram_safe.safe_send_message(sbot, 43, text, reply_markup=scanner_mid.kb_contact_admin(),
                                                    on_sent=lambda msg: sent_ids.append(msg.message_id))
        ss.append({"script": script, "text": text, "ok": ok, "calls": sbot.calls, "sleeps": sl,
                   "logs": logs_since(n0), "on_sent": sent_ids})
    ok_none = await telegram_safe.safe_send_message(None, 42, "x")
    ok_zero = await telegram_safe.safe_send_message(ScriptBot([]), 0, "x")
    telegram_safe.asyncio = REAL_ASYNCIO
    out["safe_send"] = {"cases": ss, "none_bot": ok_none, "zero_uid": ok_zero,
                        "err_text": {k: str(mk(k)) for k in ("retry", "net", "bad", "forbidden", "value")}}

    # ── _split_for_telegram ───────────────────────────────────────────────
    split_inputs = [long_text, one_line, "a\n" * 3000, ("😀" * 3899 + "\n") * 2 + "z", "short"]
    out["split"] = [{"text": t, "parts": telegram_safe._split_for_telegram(t)} for t in split_inputs]

    # ── analyze_on_demand ────────────────────────────────────────────────
    from user_manager import TradeCfg
    F.CLK.t = T0
    od = []
    cfgs = {"default15": TradeCfg(timeframe="15m"),
            "htf15": TradeCfg(timeframe="15m", use_htf=True, tp1_rr=1.5, tp2_rr=2.5),
            "strict15": TradeCfg(timeframe="15m", min_quality=7)}
    for sym in ("synlv07", "SYNLV07USDT", " synlv07-usdt ", "SYNLV07-USDT-SWAP", "BTC", "NOSUCH"):
        for name, cfg in cfgs.items():
            for lang in (None, "en"):
                r0 = len(fetcher.calls)
                n0 = len(cap.lines)
                if lang is None:
                    res = await scanner.analyze_on_demand(sym, cfg)
                else:
                    res = await scanner.analyze_on_demand_lang(sym, cfg, lang)
                rec = {"symbol": sym, "cfg": name, "lang": lang, "rest": fetcher.calls[r0:], "logs": logs_since(n0)}
                if res is None:
                    rec["result"] = None
                else:
                    sig, text = res
                    rec["result"] = {"text": text, "symbol": sig.symbol, "direction": sig.direction,
                                     "entry": sig.entry, "sl": sig.sl, "tp1": sig.tp1, "tp2": sig.tp2, "tp3": sig.tp3,
                                     "quality": sig.quality, "btc_corr": getattr(sig, "btc_corr", None),
                                     "eth_corr": getattr(sig, "eth_corr", None)}
                od.append(rec)
    out["on_demand"] = {"cfgs": {k: dataclasses.asdict(v) for k, v in cfgs.items()}, "cases": od}

    # ── _send: the scanner-level counter-trend gate (`or 4`), kill-switch, auto-trade kwargs ──
    import copy
    import auto_trade
    import chart_sender
    import balance_cache
    import market_regime
    at_calls, charts = [], []

    async def fake_at(**kw):
        kw = dict(kw)
        kw.pop("bot", None)
        at_calls.append(kw)
        return {"executed": False, "show_trade_btn": True, "limit_msg": None}
    auto_trade.execute_auto_trade = fake_at
    chart_sender.send_signal_chart_bg = lambda *a, **k: charts.append(a[1].user_id)

    async def no_balance(user, exchange):
        return None
    balance_cache.get_cached_balance = no_balance
    cache.init_cache(max_keys=Config.CACHE_MAX_KEYS)
    F.CLK.t = T0
    market_regime._cached_regime = "trending_down"
    market_regime._cached_at = T0 - 60
    base_sig, _ = await scanner.analyze_on_demand("SYNLV07", cfgs["default15"])
    ct = []
    rand_k0 = F.RAND.k
    for uid, _f in CT_USERS:
        for q in (4, 6):
            user = await um.get(uid)
            sig = copy.deepcopy(base_sig)
            sig.quality = q
            n0, s0, a0 = len(cap.lines), len(bot.sent), len(at_calls)
            ok = await scanner._send(user, sig, user.get_long_cfg())
            await F.drain()
            ct.append({"uid": uid, "quality": q, "ok": ok, "sent": bot.sent[s0:], "at_calls": at_calls[a0:],
                       "logs": logs_since(n0)})
    out["ct_gate"] = {"rand_k0": rand_k0, "regime": "trending_down", "cases": ct, "charts": charts,
                      "trades": F.trades_snapshot(), "trade_events": F.trade_events_snapshot(),
                      "users": F.users_snapshot()}

    # ── _restore_hint_throttle / _persist_hint_throttle (kv levels_hint_last_ts_v1) ──
    F.CLK.t = T0
    hint = []
    raws = [
        '{"1": 1767189000.0, "2": 1767100000, " 3 ": "1767189600", "4.5": 1767189620, "x": 1, "5": null, '
        '"6": true, "7": NaN, "8": Infinity, "9": -Infinity, "1_0": 1767189620.5, "11": [1], "12": "nan", '
        '"13": 1767160820, "14": 1767160819.9}',
        '{"2": 1767189620, "1": 1767189500, "15": 1767189621}',
        '[1, 2]', '{bad', '', '"str"', 'null',
    ]
    scanner_mid._user_hint_last_ts.clear()
    for raw in raws:
        await database.db_kv_set(scanner_mid._KV_HINT_LAST_TS, raw)
        n0 = len(cap.lines)
        await scanner_mid._restore_hint_throttle()
        hint.append({"raw": raw, "state": [[k, v] for k, v in scanner_mid._user_hint_last_ts.items()],
                     "logs": logs_since(n0)})
    F.CLK.t = T0 + 3600
    await scanner_mid._persist_hint_throttle()
    out["hint_throttle"] = {"t0": T0, "cases": hint, "persist_t": F.CLK.t,
                            "persisted": await database.db_kv_get(scanner_mid._KV_HINT_LAST_TS),
                            "after_persist": [[k, v] for k, v in scanner_mid._user_hint_last_ts.items()]}

    doc = {"meta": {"generator": "tests/engine/scanners/py/levels_units.py", "python": sys.version.split()[0]},
           "t0": T0, "users": init_rows, "bot_fail": sorted(BOT_FAIL),
           "api_keys": {str(k): list(v) for k, v in CT_KEYS.items()}, "symbols": SYMBOLS, "volumes": volumes,
           "cfg": {"PRICE_PRO": Config.PRICE_PRO, "PAYMENT_NETWORK": Config.PAYMENT_NETWORK,
                   "PAYMENT_ADDRESS": Config.PAYMENT_ADDRESS, "ADMIN_CONTACT": Config.ADMIN_CONTACT,
                   "SCAN_LOOP_SLEEP": Config.SCAN_LOOP_SLEEP, "CHUNK_SIZE": Config.CHUNK_SIZE},
           "out": out}
    F.write_json(OUT, doc, gz=OUT.endswith(".gz"))
    diff = F.tree_diff(snap_before, F.tree_snapshot())
    print("bot tree changes:", diff)
    return 1 if diff else 0


if __name__ == "__main__":
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    rc = loop.run_until_complete(main())
    sys.stdout.flush()
    os._exit(rc)
