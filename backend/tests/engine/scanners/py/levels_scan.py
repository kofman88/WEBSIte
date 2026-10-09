"""levels_scan.py — differential driver of the bot's LEVELS scanner (scanner_mid.MidScanner) for
backend/tests/engine/scanners/levels_scan.test.js.

The REAL MidScanner._cycle() runs over consecutive cycles on the golden candles
(tests/golden/candles) with the fakes of levels_fakes.py: a pinned clock, a fake REST fetcher,
a fake Telegram bot, a fresh bot-schema SQLite (database.init_db) holding 12 users of different
plans and settings (free / Pro / admin, LONG / SHORT / BOTH jobs, 15m / 1h / 4h, min_quality,
quiet hours, lite cards, multi-strategy, auto-trade on/off with a canned execute_auto_trade,
genome optimizer params, HTF filter, high-WR mode, notify off, a legacy BOTH job that gets the
[LEVELS-BACKFILL] repair, a non-LEVELS user). Each cycle seeds the live module state the
scanner reads (BTC trend + ribbon strength, cached regime, momentum relaxed mode, the WS candle
cache, the fundamental block, WS bar-close triggers) and records:

  sent       every bot.send_message (text, parse_mode, protect_content, disable_notification, kb)
  charts     send_signal_chart_bg calls (uid, strategy, df window, pivots)
  at_calls   execute_auto_trade kwargs (bot excluded)
  metrics    metrics.record calls
  rest       fetcher calls (candles / pairs / global trend)
  trades     the whole trades table (site columns), trade_events, the kv table
  registry   signal_registry._registry + the persisted JSON text
  users      user state columns (flags, counters) after the cycle
  scanner    _last_scan, _perf, indicator cooldowns (job_key → {symbol: open ms}), confluence,
             free_report missed buffer, momentum breakout map
  logs       every INFO+ log record [level, logger, message] in order

Run (bot checkout is read-only; the script chdirs there for its imports):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311>/bin/python levels_scan.py [OUT]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import levels_fakes as F  # noqa: E402  (chdirs into the bot, pins clock / random / env)

OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "..", "levels_fixtures", "scan.json.gz")

import cache  # noqa: E402
import database  # noqa: E402
import free_report  # noqa: E402
import market_regime  # noqa: E402
import momentum_detector  # noqa: E402
import signal_confluence  # noqa: E402
import signal_freshness  # noqa: E402
import signal_registry  # noqa: E402
import trend_monitor  # noqa: E402
import coin_quality_learner  # noqa: E402
import exchange_symbols  # noqa: E402
import auto_trade  # noqa: E402
import chart_sender  # noqa: E402
import balance_cache  # noqa: E402
import metrics  # noqa: E402
import optimizer  # noqa: E402
import scanner_mid  # noqa: E402
from config import Config  # noqa: E402
from user_manager import UserManager, UserSettings  # noqa: E402

T = lambda s: datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()  # noqa: E731

# ── scenario ───────────────────────────────────────────────────────────────
SYMBOLS = F.golden_symbols()
# 24 h volumes: BTC/ETH huge, a ladder for the rest, the SYNLV* below the 300k user floor
VOLUMES = {}
for i, s in enumerate(SYMBOLS):
    if s.startswith("BTC"):
        VOLUMES[s] = 9.0e9
    elif s.startswith("ETH"):
        VOLUMES[s] = 4.0e9
    elif s == "SYNLV01-USDT-SWAP":
        VOLUMES[s] = 250_000.0          # below the 300k per-user default (only U1012 scans it)
    elif s.startswith("SYNLV"):
        VOLUMES[s] = 150_000.0 + 10_000.0 * i
    else:
        VOLUMES[s] = 2.0e8 / (1 + i) + 250_000.0
GLOBAL_TREND = {"BTC": {"trend_text": "H1: 🟢 | H4: 🟢 | D1: ⚪ | W1: ❓"},
                "ETH": {"trend_text": "H1: 🔴 | H4: ⚪ | D1: ⚪ | W1: ❓"}}

KEYS = {   # uid → (exchange, api_key, api_secret) — auto-trade users (canned execute_auto_trade)
    1005: ("bingx", "bx-key-1005", "bx-secret-1005"),
    1006: ("bybit", "by-key-1006", "by-secret-1006"),
}
AT_RESULT = {   # uid → the canned execute_auto_trade result
    1005: {"executed": False, "show_trade_btn": True, "limit_msg": None},
    1006: {"executed": True, "show_trade_btn": False, "limit_msg": "⚠️ Лимит сделок: 5/5 — новые позиции не открываются"},
}
BALANCES = {1005: 2500.0, 1006: 87.5}
OPT_PARAMS = {   # (uid, strategy) → optimizer_params (regime-aware)
    (1006, "LEVELS"): {"min_rr": 2.4, "min_quality": 2, "_regime": {"trending_down": {"min_rr": 2.2, "min_quality": 4}}},
}
PRO = dict(sub_plan="pro", sub_status="active", sub_expires=T("2026-02-01T00:00:00"))

USERS = [
    # uid, fields
    (1001, dict(PRO, strategy="LEVELS", long_active=True, short_active=True, long_tf="1h", short_tf="1h",
                long_interval=3600, short_interval=3600, lang="ru", send_chart_enabled=False)),
    (1002, dict(PRO, strategy="LEVELS", long_active=True, long_tf="15m", long_interval=900, lang="en",
                signal_format="lite", min_quality=5, quiet_start=10, quiet_end=14)),
    (1003, dict(sub_plan="free", strategy="LEVELS", long_active=True, long_tf="15m", long_interval=900, lang="ru")),
    (1004, dict(sub_plan="free", strategy="LEVELS", short_active=True, short_tf="15m", short_interval=900, lang="en",
                min_volume_usdt=5.0e6)),
    (1005, dict(PRO, strategy="LEVELS", extra_strategies="SMC,VOLUME", long_active=True, short_active=True,
                long_tf="15m", short_tf="15m", long_interval=900, short_interval=900, auto_trade=True,
                trade_exchange="bingx", allow_counter_trend=False, trade_risk_pct=2.0, trade_leverage=5, lang="ru")),
    (1006, dict(PRO, strategy="LEVELS", long_active=True, short_active=True, long_tf="15m", short_tf="15m",
                long_interval=900, short_interval=900, auto_trade=True, trade_exchange="bybit",
                allow_counter_trend=True, levels_counter_trend_min_quality=0, genome_auto_apply=True, use_htf=True,
                lang="ru", min_quality=2)),
    (123, dict(sub_plan="free", strategy="LEVELS", long_active=True, short_active=True, long_tf="4h", short_tf="4h",
               long_interval=3600, short_interval=3600, lang="ru")),
    (1008, dict(PRO, strategy="LEVELS", active=True, scan_mode="both", long_active=False, short_active=False,
                vol_filter_mode="count", max_coins_count=30, cooldown_bars=0, lang="en")),
    (1010, dict(PRO, strategy="LEVELS", long_active=True, long_tf="15m", long_interval=900, notify_signal=False,
                lang="ru")),
    (1011, dict(PRO, strategy="SMC", long_active=True, smc_long_active=True, lang="ru")),
    (1012, dict(PRO, strategy="LEVELS", long_active=True, short_active=True, long_tf="15m", short_tf="1h",
                long_interval=900, short_interval=1800, high_wr_mode=True, use_volume=False, min_quality=1,
                trend_only=True, min_volume_usdt=100_000.0, lang="en",
                long_cfg='{"min_rr": 1.5, "tp1_rr": 1.5, "max_dist_pct": 3.0, "pivot_strength": 5, "_sparse": true}')),
    (1013, dict(sub_plan="free", sub_status="banned", strategy="LEVELS", long_active=True, long_tf="1h",
                long_interval=3600, lang="ru")),
    (1014, dict(PRO, strategy="LEVELS", long_active=True, short_active=True, long_tf="15m", short_tf="15m",
                long_interval=900, short_interval=900, lang="en", min_quality=4, quiet_start=22, quiet_end=7,
                long_cfg='{"tp1_rr": 2.5, "tp2_rr": 4.0, "tp3_rr": 6.0, "_sparse": true}')),
]

TREND_UP = {"15m": "LONG", "1H": "LONG", "4H": "LONG", "1D": "RANGE"}
TREND_MIX = {"15m": "SHORT", "1H": "LONG", "4H": "LONG", "1D": "LONG"}
TREND_DN = {"15m": "SHORT", "1H": "SHORT", "4H": "SHORT"}
TREND_RG = {"15m": "RANGE", "1H": "SHORT", "4H": "LONG"}
CYCLES = [
    dict(t="2025-12-31T10:00:20", trend=TREND_UP, strength={"15m": 82, "1H": 64}, regime="trending_up",
         fund="", ws=[], momentum=None),
    dict(t="2025-12-31T10:15:20", trend=TREND_UP, strength={"15m": 82}, regime="trending_up",
         fund="", ws=[["BTC-USDT-SWAP", "15m"]], momentum=None),
    dict(t="2025-12-31T12:00:20", trend=TREND_MIX, strength={"15m": 75}, regime="trending_down",
         fund="📊 F&G: 61 (Жадность) · BTC.D 57.1%", ws=[["BTC-USDT-SWAP", "1H"], ["BTC-USDT-SWAP", "4H"]],
         momentum=None),
    dict(t="2025-12-31T12:30:20", trend=TREND_DN, strength={"15m": 74, "1H": 70}, regime="trending_down",
         fund="", ws=[["BTC-USDT-SWAP", "15m"]], momentum=None),
    dict(t="2025-12-31T12:45:20", trend=TREND_DN, strength={"15m": 40}, regime="trending_down", fund="",
         ws=[["BTC-USDT-SWAP", "15m"]], momentum=None),
    dict(t="2025-12-31T13:00:20", trend=TREND_RG, strength={"15m": 30}, regime="ranging", fund="",
         ws=[["BTC-USDT-SWAP", "1H"]],
         momentum={"relaxed_for": 5400, "symbol": "BTC", "reason": "BTC pump +2.40% за 1H"}),
    dict(t="2025-12-31T14:00:20", trend=TREND_DN, strength={"15m": 66}, regime="trending_down", fund="",
         ws=[["BTC-USDT-SWAP", "1H"]], momentum=None,
         mutate=[[1001, "long_cfg", '{"max_dist_pct": 3.0, "_sparse": true}']]),
    dict(t="2025-12-31T14:45:20", trend=TREND_UP, strength={"15m": 90, "1H": 80, "4H": 71}, regime="trending_up",
         fund="", ws=[["BTC-USDT-SWAP", "15m"]], momentum=None),
    dict(t="2025-12-31T16:15:20", trend=TREND_UP, strength={"15m": 55}, regime="high_vol", fund="",
         ws=[["BTC-USDT-SWAP", "4H"], ["BTC-USDT-SWAP", "15m"]], momentum=None),
    dict(t="2025-12-31T20:00:20", trend=TREND_MIX, strength={"15m": 71}, regime="trending_up", fund="",
         ws=[["BTC-USDT-SWAP", "1H"]], momentum=None),
    dict(t="2025-12-31T21:15:20", trend=TREND_DN, strength={"15m": 71}, regime="trending_down", fund="",
         ws=[["BTC-USDT-SWAP", "15m"]], momentum=None),
    dict(t="2025-12-31T23:30:20", trend=TREND_MIX, strength={"15m": 66}, regime="trending_up", fund="",
         ws=[["BTC-USDT-SWAP", "1H"], ["BTC-USDT-SWAP", "15m"]], momentum=None),
]
for c in CYCLES:
    c["ts"] = T(c["t"])
WS_TFS = ("15m", "1D")   # the WS cache tfs seeded each cycle (1H/4H skipped: PORT_DECISIONS D6 key normalisation)
WS_MISSING = {"SYNRG08-USDT-SWAP", "SYNVL06-USDT-SWAP"}   # never in the WS cache (REST only / no price)
REST_MISSING = {"SYNRG08-USDT-SWAP"}                       # REST returns nothing either
BLACKLIST = [["SYNUP03-USDT-SWAP", "LEVELS", T("2026-01-10T00:00:00")]]
BOT_FAIL = {1012, 1014}   # TelegramForbiddenError on send (1014: a signal card → SKIP not_delivered)
UNAVAIL = {"bingx": {"SYNDN02-USDT-SWAP", "SYNRG05-USDT-SWAP"}, "bybit": {"SYNUP06-USDT-SWAP"}}


async def main():
    snap_before = F.tree_snapshot()
    cap = F.capture_logs()
    F.CLK.t = CYCLES[0]["ts"] - 600
    await database.init_db(os.environ["DB_PATH"])
    cache.init_cache(max_keys=Config.CACHE_MAX_KEYS)
    signal_registry._PERSIST_PATH = os.path.join(F.TMP, "signal_registry.json")
    signal_registry._registry.clear()
    signal_registry._stats.update({"allowed": 0, "blocked": 0})
    free_report.datetime = F.FakeDT
    scanner_mid.Config.SCAN_WORKERS = 1
    trend_monitor._state.clear()
    trend_monitor._strength.clear()

    # exchange symbol caches (native names from the bot's own converters)
    from bybit_trader import to_bybit_symbol
    from bingx_trader import to_bingx_symbol
    natives = {
        "bybit": sorted(to_bybit_symbol(s) for s in SYMBOLS if s not in UNAVAIL["bybit"]),
        "bingx": sorted(to_bingx_symbol(s) for s in SYMBOLS if s not in UNAVAIL["bingx"]),
    }
    for ex, lst in natives.items():
        exchange_symbols._symbols[ex] = set(lst)
    exchange_symbols._updated_at = F.CLK.t
    exchange_symbols._emit_metric_fire_and_forget = lambda *a, **k: None
    coin_quality_learner._blacklist.clear()
    for sym, strat, until in BLACKLIST:
        coin_quality_learner._blacklist[(sym, strat)] = until

    # fakes
    fetcher = F.FakeFetcher(VOLUMES, GLOBAL_TREND)
    fetcher.missing = set(REST_MISSING)
    bot = F.FakeBot()
    bot.fail = set(BOT_FAIL)
    at_calls, charts, metric_calls = [], [], []

    async def fake_execute_auto_trade(**kw):
        kw = dict(kw)
        kw.pop("bot", None)
        at_calls.append(kw)
        return dict(AT_RESULT.get(kw.get("user_id"), {"executed": False, "show_trade_btn": False, "limit_msg": None}))
    auto_trade.execute_auto_trade = fake_execute_auto_trade

    def fake_chart(bot_, user, sig, df, strategy="LEVELS", lang="ru", pivot_levels=None, hvn_levels=None,
                   lvn_levels=None, extra_signal_data=None):
        charts.append({"uid": user.user_id, "strategy": strategy, "lang": lang, "symbol": sig.symbol,
                       "df_len": len(df), "df_last": F.ms_of(df.index[-1]), "pivots": list(pivot_levels or []),
                       "hvn": list(hvn_levels or []), "lvn": list(lvn_levels or []), "extra": extra_signal_data})
    chart_sender.send_signal_chart_bg = fake_chart

    async def fake_balance(user, exchange):
        return BALANCES.get(user.user_id)
    balance_cache.get_cached_balance = fake_balance

    async def fake_record(name, value=1.0, tags=None, **kw):
        metric_calls.append([name, value, dict(tags or {})])
    metrics.record = fake_record

    async def fake_load_params(uid, strategy):
        p = OPT_PARAMS.get((int(uid), strategy))
        return copy.deepcopy(p) if p is not None else None
    optimizer.load_params = fake_load_params

    fund = {"block": ""}

    async def fake_fund_block():
        return fund["block"]
    scanner_mid._FUND_OK = True
    scanner_mid._fund = type("FundStub", (), {"get_market_context_block": staticmethod(fake_fund_block)})

    # users
    um = UserManager()
    for uid, fields in USERS:
        u = UserSettings(user_id=uid)
        for k, v in fields.items():
            setattr(u, k, v)
        if uid in KEYS:
            ex, key, sec = KEYS[uid]
            setattr(u, f"{ex}_api_key", key)
            setattr(u, f"{ex}_api_secret", sec)
        await um.save(u)
    init_rows = F.sqlite_rows("SELECT * FROM users ORDER BY user_id")
    for r in init_rows:
        for c in [c for c in r if c.endswith("_api_key") or c.endswith("_api_secret") or c.endswith("_passphrase")]:
            r[c] = ""   # encrypted at rest — the replay gets the keys from `api_keys`

    scanner = scanner_mid.MidScanner(Config, bot, um)
    scanner.fetcher = fetcher
    cap.lines.clear()
    kv_baseline = F.kv_snapshot()

    out_cycles = []
    prev = {"sent": 0, "charts": 0, "at": 0, "metrics": 0, "rest": 0, "logs": 0}
    for ci, cyc in enumerate(CYCLES):
        F.CLK.t = cyc["ts"]
        # live module state the scanner reads
        trend_monitor._state.clear()
        for tf, tr in cyc["trend"].items():
            trend_monitor._state[tf] = {"trend": tr, "since": cyc["ts"] - 3600.0, "price": 90000.0}
        trend_monitor._strength.clear()
        trend_monitor._strength.update(cyc["strength"])
        market_regime._cached_regime = cyc["regime"]
        market_regime._cached_at = cyc["ts"] - 60.0
        if cyc["momentum"]:
            m = cyc["momentum"]
            momentum_detector.activate_relaxed(m["symbol"], m["reason"], 2.4, 1.1)
            momentum_detector._state.relaxed_until = cyc["ts"] + m["relaxed_for"]
        fund["block"] = cyc["fund"]
        for uid, field, value in cyc.get("mutate", []):
            u = await um.get(uid)
            setattr(u, field, value)
            await um.save(u)
        for sym in SYMBOLS:
            if sym in F_WS_MISSING:
                continue
            for tf in WS_TFS:
                df = F.frame_at(sym, tf, cyc["ts"], 300)
                if df is not None:
                    await cache.set_candles(sym, "1D" if tf == "1D" else tf, df, Config.CACHE_TTL)
        for inst, tf in cyc["ws"]:
            await scanner._on_ws_bar_close(inst, tf)

        await scanner._cycle()
        await F.drain()

        indic = {}
        for jk, ind in scanner._indicators.items():
            indic[jk] = {s: F.ms_of(v) for s, v in ind._last_signal.items()}
        reg_file = None
        if os.path.exists(signal_registry._PERSIST_PATH):
            with open(signal_registry._PERSIST_PATH, encoding="utf-8") as fh:
                reg_file = fh.read()
        rec = {
            "sent": bot.sent[prev["sent"]:],
            "charts": charts[prev["charts"]:],
            "at_calls": at_calls[prev["at"]:],
            "metrics": metric_calls[prev["metrics"]:],
            "rest": fetcher.calls[prev["rest"]:],
            "logs": cap.lines[prev["logs"]:],
            "trades": F.trades_snapshot(),
            "trade_events": F.trade_events_snapshot(),
            "kv": F.kv_snapshot(),
            "registry": {"|".join(str(p) for p in k): v for k, v in signal_registry._registry.items()},
            "registry_file": reg_file,
            "registry_stats": signal_registry.get_stats(),
            "users": F.users_snapshot(),
            "last_scan": dict(scanner._last_scan),
            "perf": {k: v for k, v in scanner._perf.items()},
            "indicators": indic,
            "confluence": signal_confluence.get_stats(),
            "missed": {str(k): v for k, v in free_report._missed_buffer.items()},
            "breakout": dict(momentum_detector._last_breakout_alert),
            "momentum": {"relaxed": momentum_detector._state.relaxed, "until": momentum_detector._state.relaxed_until},
            "freshness_ema": dict(getattr(signal_freshness, "_cycle_ema", {})),
            "cache": cache.cache_stats(),
            "rand_k": F.RAND.k,
        }
        prev = {"sent": len(bot.sent), "charts": len(charts), "at": len(at_calls), "metrics": len(metric_calls),
                "rest": len(fetcher.calls), "logs": len(cap.lines)}
        out_cycles.append(rec)
        print(f"cycle {ci} {cyc['t']}: sent={len(rec['sent'])} trades={len(rec['trades'])} logs={len(rec['logs'])}")

    doc = {
        "meta": {"generator": "tests/engine/scanners/py/levels_scan.py", "python": sys.version.split()[0],
                 "scan_workers": 1, "ws_tfs": list(WS_TFS)},
        "symbols": SYMBOLS, "volumes": VOLUMES, "global_trend": GLOBAL_TREND,
        "users": init_rows, "api_keys": {str(k): list(v) for k, v in KEYS.items()},
        "at_result": {str(k): v for k, v in AT_RESULT.items()}, "balances": {str(k): v for k, v in BALANCES.items()},
        "opt_params": [[k[0], k[1], v] for k, v in OPT_PARAMS.items()],
        "exchange_symbols": natives, "blacklist": BLACKLIST, "bot_fail": sorted(BOT_FAIL),
        "ws_missing": sorted(F_WS_MISSING), "rest_missing": sorted(REST_MISSING),
        "cache_ttl": Config.CACHE_TTL, "cache_max_keys": Config.CACHE_MAX_KEYS,
        "start_t": CYCLES[0]["ts"] - 600,
        "kv_baseline": kv_baseline,
        "cycles": [{k: v for k, v in c.items()} for c in CYCLES],
        "expected": out_cycles,
    }
    F.write_json(OUT, doc, gz=OUT.endswith(".gz"))
    # integrity: nothing in the bot tree changed
    diff = F.tree_diff(snap_before, F.tree_snapshot())
    print("bot tree changes:", diff)
    return 1 if diff else 0


F_WS_MISSING = WS_MISSING

if __name__ == "__main__":
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    rc = loop.run_until_complete(main())
    sys.stdout.flush()
    os._exit(rc)   # the bot's executor / aiosqlite threads would keep the interpreter alive
