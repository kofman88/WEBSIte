"""volume_scan.py — differential driver of the bot's VOLUME scanner (volume_scanner.py) for
backend/tests/engine/scanners/volume_scan.test.js.

The REAL volume_scanner._scan_cycle(bot, um, fetcher) runs over consecutive cycles on the golden
candles (tests/golden/candles) with the fakes of levels_fakes.py (pinned clock, counter randint,
fake REST fetcher, recording bot, canned execute_auto_trade / balances / charts / metrics) and a
fresh bot-schema SQLite holding 14 users: Pro groups sharing one (TF, cfg) group, 15m / 1h / 4h,
an invalid TF (→ 1h), custom kv configs (save_user_cfg, an unparsable value → [VOLUME-CFG]
default, reset_user_cfg mid-run), multi-strategy (LEVELS + extra VOLUME), free (not eligible),
admin on free (eligible), a banned free user, no vol_* flag, auto-trade (Market; executed / limit
message / raising), lite + en cards, quiet hours, chart off, an exchange without the coin
(record_skip), a coin blacklisted for VOLUME, a blocked bot (SKIP not_delivered, still counted
toward the per-user cap and kept in _sent_bars). Each cycle seeds the BTC trend state, the WS
candle cache (15m / 1H / 4H / 1D; some coins missing or short → REST; a REST failure on the HTF
→ resample of the LTF) and records:

  sent / charts / at_calls / metrics / rest / logs    as in levels_scan.py
  trades, trade_events, kv, registry (+ persisted JSON), users
  sent_bars (_sent_bars), htf (_htf_cache: key → loaded ts, rows, last bar), skips
  (exchange_symbols skip counter + samples), confluence stats, gc (gc_sent() result when run)

Run (bot checkout is read-only; the script chdirs there for its imports):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311>/bin/python volume_scan.py [OUT]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import levels_fakes as F  # noqa: E402  (chdirs into the bot, pins clock / random / env)

OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "..", "volume_fixtures", "scan.json.gz")

import cache  # noqa: E402
import database  # noqa: E402
import signal_confluence  # noqa: E402
import signal_registry  # noqa: E402
import trend_monitor  # noqa: E402
import coin_quality_learner  # noqa: E402
import exchange_symbols  # noqa: E402
import auto_trade  # noqa: E402
import chart_sender  # noqa: E402
import balance_cache  # noqa: E402
import metrics  # noqa: E402
import volume_scanner  # noqa: E402
from config import Config  # noqa: E402
from user_manager import UserManager, UserSettings  # noqa: E402

T = lambda s: datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()  # noqa: E731

# ── scenario ───────────────────────────────────────────────────────────────
SYMBOLS = F.golden_symbols()
VOLUMES = {}
for i, s in enumerate(SYMBOLS):
    if s.startswith("BTC"):
        VOLUMES[s] = 9.0e9
    elif s.startswith("ETH"):
        VOLUMES[s] = 4.0e9
    elif s.startswith("SYNLV"):
        VOLUMES[s] = 150_000.0 + 20_000.0 * i      # below the 300k floor → out of the universe
    else:
        VOLUMES[s] = 2.0e8 / (1 + i) + 350_000.0

KEYS = {   # uid → (exchange, api_key, api_secret)
    2003: ("bybit", "by-key-2003", "by-secret-2003"),
    2013: ("bingx", "bx-key-2013", "bx-secret-2013"),
    2014: ("bybit", "by-key-2014", "by-secret-2014"),
}
AT_RESULT = {   # uid → canned execute_auto_trade result ("raise" → RuntimeError)
    2003: {"executed": True, "show_trade_btn": False, "limit_msg": None},
    2013: "raise",
    2014: {"executed": False, "show_trade_btn": True, "limit_msg": "⚠️ Trade limit: 5/5 — no new positions"},
}
BALANCES = {2003: 1200.0, 2014: 40.0}
PRO = dict(sub_plan="pro", sub_status="active", sub_expires=T("2026-02-01T00:00:00"))

USERS = [
    (2001, dict(PRO, strategy="VOLUME", vol_long_active=True, vol_short_active=True, vol_timeframe="1h", lang="ru")),
    (2002, dict(PRO, strategy="VOLUME", vol_long_active=True, vol_short_active=True, vol_timeframe="1h", lang="en",
                signal_format="lite", quiet_start=12, quiet_end=18)),
    (2003, dict(PRO, strategy="LEVELS", extra_strategies="VOLUME", long_active=True, vol_long_active=True,
                vol_timeframe="15m", auto_trade=True, trade_exchange="bybit", trade_risk_pct=1.5, trade_leverage=7,
                auto_trade_mode="auto", max_trades_limit=4, lang="ru")),
    (2004, dict(PRO, strategy="VOLUME", vol_long_active=True, vol_short_active=True, vol_timeframe="4h", lang="ru")),
    (2005, dict(sub_plan="free", strategy="VOLUME", vol_long_active=True, vol_timeframe="1h", lang="ru")),
    (123, dict(sub_plan="free", strategy="VOLUME", vol_long_active=True, vol_short_active=True, vol_timeframe="1h",
               lang="ru")),
    (2007, dict(PRO, strategy="VOLUME", vol_long_active=True, vol_short_active=True, vol_timeframe="1h",
                trade_exchange="bingx", send_chart_enabled=False, lang="en")),
    (2008, dict(PRO, strategy="VOLUME", vol_long_active=True, vol_short_active=True, vol_timeframe="1h", lang="ru")),
    (2009, dict(PRO, strategy="VOLUME", vol_short_active=True, vol_timeframe="15m", min_volume_usdt=5.0e8,
                lang="en")),
    (2010, dict(sub_plan="free", sub_status="banned", strategy="VOLUME", vol_long_active=True, lang="ru")),
    (2011, dict(PRO, strategy="VOLUME", vol_long_active=True, vol_short_active=True, vol_timeframe="5m", lang="ru")),
    (2012, dict(PRO, strategy="VOLUME", long_active=True, lang="ru")),
    (2013, dict(PRO, strategy="VOLUME", vol_long_active=True, vol_short_active=True, vol_timeframe="1h",
                auto_trade=True, trade_exchange="bingx", lang="ru")),
    (2014, dict(PRO, strategy="SMC", extra_strategies="LEVELS,VOLUME", smc_long_active=True, vol_long_active=True,
                vol_short_active=True, vol_timeframe="1h", auto_trade=True, trade_exchange="bybit",
                trade_risk_pct=2.0, trade_leverage=3, lang="en", signal_format="lite")),
]
# kv volume_cfg_<uid>: ["save", params] → volume_scanner.save_user_cfg, ["raw", text] → db_kv_set
CFG_INIT = [
    [2004, "save", {"min_quality": 2, "use_htf": False, "setup_ribbon": False, "tp1_rr": 1.2}],
    [2007, "save", {"use_htf": False}],
    [2011, "raw", "{bad json"],
    [2013, "save", {"vol_mult": 1.2, "sl_atr_mult": 1.8, "max_sl_pct": 5.0}],
]
BLACKLIST = [["SYNRG02-USDT-SWAP", "VOLUME", T("2026-03-01T00:00:00")]]
BOT_FAIL = {2008}
UNAVAIL = {"bybit": {"SYNUP06-USDT-SWAP"}, "bingx": {"SYNRG03-USDT-SWAP", "SYNDN05-USDT-SWAP"}}
WS_TFS = ("15m", "1H", "4H", "1D")
WS_MISSING = {"SYNVL02-USDT-SWAP", "SYNDN07-USDT-SWAP"}           # no WS cache at all → REST
WS_SHORT = {"SYNRG01-USDT-SWAP": 120}                              # too few cached bars → REST
WS_NO_HTF = {"SYNUP07-USDT-SWAP": ("1H",)}                         # HTF missing from the cache
REST_MISSING = {"SYNVL04-USDT-SWAP"}                               # REST returns None
REST_RAISE = [["SYNUP07-USDT-SWAP", "1h"]]                         # HTF REST raises → resample

TREND_UP = {"15m": "LONG", "1H": "LONG", "4H": "LONG", "1D": "RANGE"}
TREND_DN = {"15m": "SHORT", "1H": "SHORT", "4H": "SHORT", "1D": "SHORT"}
TREND_MIX = {"15m": "SHORT", "1H": "LONG", "4H": "LONG"}
CYCLES = [
    dict(t="2025-12-31T13:00:20", trend=TREND_UP, strength={"15m": 82, "1H": 64}),
    dict(t="2025-12-31T13:01:20", trend=TREND_UP, strength={"15m": 82, "1H": 64}),
    dict(t="2025-12-31T14:00:20", trend=TREND_MIX, strength={"15m": 40}),
    dict(t="2025-12-31T15:30:20", trend=TREND_DN, strength={"15m": 75, "1H": 72, "4H": 70}),
    dict(t="2025-12-31T16:00:20", trend=TREND_UP, strength={"15m": 90, "1H": 80},
         cfg=[[2004, "reset"]]),
    dict(t="2025-12-31T18:00:20", trend=TREND_MIX, strength={"15m": 55}, gc=True),
    dict(t="2025-12-31T20:00:20", trend=TREND_DN, strength={"15m": 71, "1H": 75}),
    dict(t="2025-12-31T21:00:20", trend=TREND_UP, strength={"15m": 30}, gc=True,
         cfg=[[2007, "save", {"use_htf": True, "min_quality": 4}]]),
]
for c in CYCLES:
    c["ts"] = T(c["t"])


async def main() -> int:
    snap_before = F.tree_snapshot()
    cap = F.capture_logs()
    F.CLK.t = CYCLES[0]["ts"] - 600
    await database.init_db(os.environ["DB_PATH"])
    cache.init_cache(max_keys=Config.CACHE_MAX_KEYS)
    signal_registry._PERSIST_PATH = os.path.join(F.TMP, "signal_registry.json")
    signal_registry._registry.clear()
    signal_registry._stats.update({"allowed": 0, "blocked": 0})
    trend_monitor._state.clear()
    trend_monitor._strength.clear()
    volume_scanner._sent_bars.clear()
    volume_scanner._htf_cache.clear()

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
    exchange_symbols._skip_counter = 0
    exchange_symbols._skip_samples = {}
    coin_quality_learner._blacklist.clear()
    for sym, strat, until in BLACKLIST:
        coin_quality_learner._blacklist[(sym, strat)] = until

    fetcher = F.FakeFetcher(VOLUMES, {})
    fetcher.missing = set(REST_MISSING)
    fetcher.raise_on = {(s, tf) for s, tf in REST_RAISE}
    bot = F.FakeBot()
    bot.fail = set(BOT_FAIL)
    at_calls, charts, metric_calls = [], [], []

    async def fake_execute_auto_trade(**kw):
        kw = dict(kw)
        kw.pop("bot", None)
        at_calls.append(kw)
        res = AT_RESULT.get(kw.get("user_id"), {"executed": False, "show_trade_btn": False, "limit_msg": None})
        if res == "raise":
            raise RuntimeError("exchange down")
        return dict(res)
    auto_trade.execute_auto_trade = fake_execute_auto_trade

    def fake_chart(bot_, user, sig, df, strategy="LEVELS", lang="ru", pivot_levels=None, hvn_levels=None,
                   lvn_levels=None, extra_signal_data=None):
        charts.append({"uid": user.user_id, "strategy": strategy, "lang": lang, "symbol": sig.symbol,
                       "df_len": len(df), "df_last": F.ms_of(df.index[-1])})
    chart_sender.send_signal_chart_bg = fake_chart

    async def fake_balance(user, exchange):
        return BALANCES.get(user.user_id)
    balance_cache.get_cached_balance = fake_balance

    async def fake_record(name, value=1.0, tags=None, **kw):
        metric_calls.append([name, value, dict(tags or {})])
    metrics.record = fake_record

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
            r[c] = ""
    for uid, op, arg in CFG_INIT:
        if op == "save":
            await volume_scanner.save_user_cfg(uid, arg)
        else:
            await database.db_kv_set(volume_scanner.KV_CFG_PREFIX + str(uid), arg)
    kv_init = F.kv_snapshot()
    cap.lines.clear()

    out_cycles = []
    prev = {"sent": 0, "charts": 0, "at": 0, "metrics": 0, "rest": 0, "logs": 0}
    for ci, cyc in enumerate(CYCLES):
        F.CLK.t = cyc["ts"]
        trend_monitor._state.clear()
        for tf, tr in cyc["trend"].items():
            trend_monitor._state[tf] = {"trend": tr, "since": cyc["ts"] - 3600.0, "price": 90000.0}
        trend_monitor._strength.clear()
        trend_monitor._strength.update(cyc["strength"])
        for op in cyc.get("cfg", []):
            if op[1] == "reset":
                await volume_scanner.reset_user_cfg(op[0])
            else:
                await volume_scanner.save_user_cfg(op[0], op[2])
        for sym in SYMBOLS:
            if sym in WS_MISSING:
                continue
            for tf in WS_TFS:
                if tf in WS_NO_HTF.get(sym, ()):
                    continue
                df = F.frame_at(sym, tf, cyc["ts"], WS_SHORT.get(sym, 300))
                if df is not None:
                    await cache.set_candles(sym, tf, df, Config.CACHE_TTL)
        gc = None
        if cyc.get("gc"):
            gc = volume_scanner.gc_sent()

        await volume_scanner._scan_cycle(bot, um, fetcher)
        await F.drain()

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
            "sent_bars": {"|".join(str(p) for p in k): v for k, v in volume_scanner._sent_bars.items()},
            "htf": {f"{k[0]}|{k[1]}": [v[0], len(v[1]), F.ms_of(v[1].index[-1])] for k, v in volume_scanner._htf_cache.items()},
            "skips": [exchange_symbols._skip_counter, dict(exchange_symbols._skip_samples)],
            "confluence": signal_confluence.get_stats(),
            "gc": gc,
            "rand_k": F.RAND.k,
        }
        prev = {"sent": len(bot.sent), "charts": len(charts), "at": len(at_calls), "metrics": len(metric_calls),
                "rest": len(fetcher.calls), "logs": len(cap.lines)}
        out_cycles.append(rec)
        print(f"cycle {ci} {cyc['t']}: sent={len(rec['sent'])} trades={len(rec['trades'])} logs={len(rec['logs'])}")

    doc = {
        "meta": {"generator": "tests/engine/scanners/py/volume_scan.py", "python": sys.version.split()[0],
                 "ws_tfs": list(WS_TFS)},
        "symbols": SYMBOLS, "volumes": VOLUMES,
        "users": init_rows, "api_keys": {str(k): list(v) for k, v in KEYS.items()},
        "at_result": {str(k): v for k, v in AT_RESULT.items()}, "balances": {str(k): v for k, v in BALANCES.items()},
        "exchange_symbols": natives, "blacklist": BLACKLIST, "bot_fail": sorted(BOT_FAIL),
        "cfg_init": CFG_INIT, "kv_init": kv_init,
        "ws_missing": sorted(WS_MISSING), "ws_short": WS_SHORT, "ws_no_htf": {k: list(v) for k, v in WS_NO_HTF.items()},
        "rest_missing": sorted(REST_MISSING), "rest_raise": REST_RAISE,
        "cache_ttl": Config.CACHE_TTL, "cache_max_keys": Config.CACHE_MAX_KEYS,
        "start_t": CYCLES[0]["ts"] - 600,
        "cycles": CYCLES,
        "expected": out_cycles,
    }
    F.write_json(OUT, doc, gz=OUT.endswith(".gz"))
    diff = F.tree_diff(snap_before, F.tree_snapshot())
    print("bot tree changes:", diff)
    return 1 if diff else 0


if __name__ == "__main__":
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    rc = loop.run_until_complete(main())
    sys.stdout.flush()
    os._exit(rc)   # the bot's executor / aiosqlite threads would keep the interpreter alive
