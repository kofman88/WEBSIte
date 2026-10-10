"""volume_units.py — unit-level differential vectors of the bot's VOLUME scanner (volume_scanner.py)
for backend/tests/engine/scanners/volume_units.test.js. The REAL bot functions run with the
levels_fakes.py doubles:

  helpers     dedup_ttl_s, user_tf, the group key json.dumps(cfg.to_dict(), sort_keys=True),
              str(df.index[-1]) bar keys
  cfg         load_user_cfg over raw kv values (valid / sparse / coercions / _fix / falsy JSON /
              non-dict JSON / broken JSON / empty), save_user_cfg (keep_prefs merge),
              reset_user_cfg (non-default prefs kept)
  gc          gc_sent() over fresh / stale _sent_bars and _htf_cache entries
  wake        _on_ws_bar_close(inst, tf) → the wake event per TF
  loop        run_volume_scanner over stub cycles: ok / error backoff 10 → 20 s / WS wake /
              300 s timeout / cancellation, heartbeats, the wake-or-interval sleep
  batch_d     [VOL-LIQ-15M] coins_floor_for_tf / coins_for_tf (env, vol_by_sym shapes, logs);
              [VOL-POST-SL-PAUSE] post_sl_pause_bars, _sl_end_ts, post_sl_pause_active against seeded
              trades rows (7 vs 9 bars, other direction / user / strategy, BE / TP3 / TP1 previous,
              latest delivered decides, undelivered ignored, exchange result + state_changed_at,
              created_at fallback, 1h / 4h bars, env), the failing query (fail-open WARNING),
              gc_sent of _pause_logged; [VOL-MIN-VOLUME] save_user_cfg storage / round-trip rule

Run (bot checkout is read-only):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311>/bin/python volume_units.py [OUT]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import types
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import levels_fakes as F  # noqa: E402

OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "..", "volume_fixtures", "units.json.gz")

import database  # noqa: E402
import volume_scanner  # noqa: E402
from volume_strategy import VolumeConfig  # noqa: E402
from user_manager import UserSettings  # noqa: E402

T = lambda s: datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()  # noqa: E731
REAL_ASYNCIO = asyncio
T0 = T("2025-12-31T16:00:20")


class TimeProxy:
    def __getattr__(self, name):
        return getattr(F._time, name)

    @staticmethod
    def time():
        return F.CLK.t

    @staticmethod
    def monotonic():
        return F.CLK.t


RAW_CFGS = [
    '{"min_quality": 2, "use_htf": false}',
    '{"min_quality": "4", "ma_type": " EMA ", "use_htf": "yes", "setup_ribbon": "off", "vol_mult": "1.75", '
    '"ema_trend": 150.9, "unknown": 1, "tp2_rr": null}',
    '{"ma_fast": 1, "ma_mid": 1, "ma_slow": 3, "ema_mid": 2, "ema_trend": 3, "vol_mult": 9.0, "climax_mult": 2}',
    '{"min_quality": "x", "sl_atr_mult": [1], "cross_lookback": 99, "turn_slope_bars": 0}',
    '{}', 'null', '""', '0', '[]', '[1, 2]', '5', '2.5', 'true', '"str"', 'NaN', '{bad json', '{"a": 1} x', '',
    '{"min_quality": 3, "min_quality": 5}',
]


ENV_KEYS = ("VOLUME_MIN_SL_PCT_15M", "VOLUME_MIN_SETUP_VOL_MULT", "VOLUME_15M_COINS_FLOOR_USDT", "VOLUME_POST_SL_PAUSE_BARS")
# [VOL-POST-SL-PAUSE] seeded trades rows (the bot's `trades` = the site's signal_trades): delivered VOLUME
# signals ending SL / BE / TP3 / open at known times before T0, other users / directions / strategies,
# undelivered rows, exchange results (result='SL' + state_changed_at) and the created_at fallback.
B15 = 900.0
PAUSE_ROWS = [
    # trade_id, uid, symbol, direction, strategy, tf, created_at, signal_msg_id, order_id, stage, progress_ts, result, state_changed_at
    ["p01", 7001, "BTC-USDT-SWAP", "LONG", "VOLUME", "15m", T0 - 30 * B15, 11, "", "SL", T0 - 7 * B15, "", T0 - 30 * B15],
    ["p02", 7001, "ETH-USDT-SWAP", "LONG", "VOLUME", "15m", T0 - 30 * B15, 12, "", "SL", T0 - 9 * B15, "", T0 - 30 * B15],
    ["p03", 7002, "ETH-USDT-SWAP", "LONG", "VOLUME", "15m", T0 - 20 * B15, 13, "", "SL", T0 - 7.5 * B15, "", 0.0],
    ["p04", 7001, "SOL-USDT-SWAP", "LONG", "SMC", "15m", T0 - 20 * B15, 14, "", "SL", T0 - 2 * B15, "", 0.0],
    ["p05", 7001, "XRP-USDT-SWAP", "LONG", "VOLUME", "15m", T0 - 20 * B15, 15, "", "BE", T0 - 2 * B15, "", 0.0],
    ["p06", 7001, "ADA-USDT-SWAP", "LONG", "VOLUME", "15m", T0 - 20 * B15, 16, "", "TP3", T0 - 2 * B15, "TP3", T0 - 2 * B15],
    ["p07", 7001, "DOT-USDT-SWAP", "LONG", "VOLUME", "15m", T0 - 20 * B15, 17, "", "TP1", T0 - 2 * B15, "", 0.0],
    # the latest delivered decides: older SL + newer BE (no pause) / older BE + newer SL (pause)
    ["p08", 7001, "LINK-USDT-SWAP", "LONG", "VOLUME", "15m", T0 - 40 * B15, 18, "", "SL", T0 - 3 * B15, "", 0.0],
    ["p09", 7001, "LINK-USDT-SWAP", "LONG", "VOLUME", "15m", T0 - 10 * B15, 19, "", "BE", T0 - 1 * B15, "", 0.0],
    ["p10", 7001, "AVAX-USDT-SWAP", "SHORT", "VOLUME", "15m", T0 - 40 * B15, 20, "", "BE", T0 - 30 * B15, "", 0.0],
    ["p11", 7001, "AVAX-USDT-SWAP", "SHORT", "VOLUME", "15m", T0 - 10 * B15, 21, "", "SL", T0 - 4 * B15, "", 0.0],
    # a newer UNDELIVERED row (no card, no order) is ignored
    ["p12", 7001, "DOGE-USDT-SWAP", "LONG", "VOLUME", "15m", T0 - 40 * B15, 22, "", "BE", T0 - 20 * B15, "", 0.0],
    ["p13", 7001, "DOGE-USDT-SWAP", "LONG", "VOLUME", "15m", T0 - 5 * B15, 0, "", "SL", T0 - 1 * B15, "SKIP", T0 - 5 * B15],
    # exchange results: result='SL' (+ state_changed_at), order only (signal_msg_id 0); created_at fallback
    ["p14", 7001, "BNB-USDT-SWAP", "LONG", "VOLUME", "1h", T0 - 30 * B15, 0, "ord-14", "", 0.0, "SL", T0 - 3 * B15],
    ["p15", 7001, "TRX-USDT-SWAP", "LONG", "VOLUME", "1h", T0 - 6 * B15, 0, "ord-15", "", 0.0, "SL", 0.0],
    ["p16", 7001, "LTC-USDT-SWAP", "long", "volume", "15m", T0 - 30 * B15, 23, "", "sl", T0 - 2 * B15, "", 0.0],
    ["p17", 7003, "BTC-USDT-SWAP", "SHORT", "VOLUME", "4h", T0 - 300 * B15, 24, "", "", 0.0, "SL", T0 - 120 * B15],
    ["p18", 7003, "ETH-USDT-SWAP", "SHORT", "VOLUME", "4h", T0 - 300 * B15, 25, "", "SL", T0 - 129 * B15, "SL", T0 - 100 * B15],
]
PAUSE_Q = [
    # uid, symbol, direction, tf, env VOLUME_POST_SL_PAUSE_BARS
    [7001, "BTC-USDT-SWAP", "LONG", "15m", None], [7001, "ETH-USDT-SWAP", "LONG", "15m", None],
    [7001, "BTC-USDT-SWAP", "SHORT", "15m", None], [7002, "BTC-USDT-SWAP", "LONG", "15m", None],
    [7002, "ETH-USDT-SWAP", "LONG", "15m", None], [7001, "SOL-USDT-SWAP", "LONG", "15m", None],
    [7001, "XRP-USDT-SWAP", "LONG", "15m", None], [7001, "ADA-USDT-SWAP", "LONG", "15m", None],
    [7001, "DOT-USDT-SWAP", "LONG", "15m", None], [7001, "LINK-USDT-SWAP", "LONG", "15m", None],
    [7001, "AVAX-USDT-SWAP", "SHORT", "15m", None], [7001, "DOGE-USDT-SWAP", "LONG", "15m", None],
    [7001, "BNB-USDT-SWAP", "LONG", "15m", None], [7001, "BNB-USDT-SWAP", "LONG", "1h", None],
    [7001, "TRX-USDT-SWAP", "LONG", "15m", None], [7001, "TRX-USDT-SWAP", "LONG", "1h", None],
    [7001, "LTC-USDT-SWAP", "LONG", "15m", None], [7001, "LTC-USDT-SWAP", "long", "15m", None],
    [7001, "BTC-USDT-SWAP", "LONG", "1h", None], [7001, "BTC-USDT-SWAP", "LONG", "4h", None],
    [7001, "ETH-USDT-SWAP", "LONG", "1h", None], [7001, "BTC-USDT-SWAP", "LONG", " 15M ", None],
    [7001, "BTC-USDT-SWAP", "LONG", "5m", None], [7001, "BTC-USDT-SWAP", "LONG", "", None],
    [7003, "BTC-USDT-SWAP", "SHORT", "4h", None], [7003, "ETH-USDT-SWAP", "SHORT", "4h", None],
    [7003, "BTC-USDT-SWAP", "SHORT", "1h", None],
    [7001, "BTC-USDT-SWAP", "LONG", "15m", "6"], [7001, "BTC-USDT-SWAP", "LONG", "15m", "0"],
    [7001, "BTC-USDT-SWAP", "LONG", "15m", "-2"], [7001, "BTC-USDT-SWAP", "LONG", "15m", "7.9"],
    [7001, "BTC-USDT-SWAP", "LONG", "15m", "abc"], [7001, "ETH-USDT-SWAP", "LONG", "15m", "10"],
    [7001, "BTC-USDT-SWAP", "LONG", "15m", "1e3"],
]


def _seed_pause_rows():
    import sqlite3
    con = sqlite3.connect(os.environ["DB_PATH"])
    try:
        for r in PAUSE_ROWS:
            con.execute("INSERT INTO trades (trade_id, user_id, symbol, direction, strategy, timeframe, created_at, signal_msg_id, "
                        "order_id, progress_stage, progress_ts, result, state_changed_at, entry, sl, tp1, tp2, tp3) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,100.0,99.0,101.0,102.0,103.0)", r)
        con.commit()
    finally:
        con.close()


async def batch_d(cap) -> dict:
    """[VOL-LIQ-15M] [VOL-POST-SL-PAUSE] [VOL-MIN-VOLUME] 2026-10 — each case in a fresh process state
    (_ENV_WARNED / _FLOOR_LOGGED cleared, the given env only), with its log lines."""
    import volume_strategy as vs
    import db.signal_progress as sp

    def fresh(**env):
        for k in ENV_KEYS:
            os.environ.pop(k, None)
        for k, v in env.items():
            if v is not None:
                os.environ[k] = v
        vs._ENV_WARNED.clear()
        vs._FLOOR_LOGGED.clear()
        return len(cap.lines)

    out: dict = {}
    # coins_floor_for_tf
    rows = []
    for env_v in (None, "", "0", "-5", "100000", "300000", "300001", "5e6", "1e7", "abc", "inf", "2_000_000"):
        for tf in ("15m", "15M", " 15m", "1h", "4h", "", None, "1d"):
            n0 = fresh(VOLUME_15M_COINS_FLOOR_USDT=env_v)
            rows.append({"env": env_v, "tf": tf, "v": volume_scanner.coins_floor_for_tf(tf), "logs": cap.lines[n0:]})
    out["coins_floor"] = rows
    # coins_for_tf
    coins = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]
    vmaps = {
        "normal": {"A": 6e6, "B": 5e6, "C": 4.99e6, "D": "7e6", "E": None, "F": float("nan"), "G": 1e5, "I": "abc",
                   "J": 2e7},
        "all_ok": {c: 9e6 for c in coins},
        "empty": {},
        "none": None,
        "few": {"A": 1e9},
    }
    rows = []
    for vname, vmap in vmaps.items():
        for tf in ("15m", "1h", "4h"):
            for env_v in (None, "0", "8e6", "abc"):
                for cl in (coins, [], ["B", "C"]):
                    n0 = fresh(VOLUME_15M_COINS_FLOOR_USDT=env_v)
                    rows.append({"vmap": vname, "tf": tf, "env": env_v, "coins": cl,
                                 "out": volume_scanner.coins_for_tf(cl, tf, vmap), "logs": cap.lines[n0:]})
    out["coins_for_tf"] = rows
    out["vmaps"] = {k: v for k, v in vmaps.items()}
    # post_sl_pause_bars / _sl_end_ts
    rows = []
    for env_v in (None, "", "8", "6", "0", "-3", "2.9", "abc", "1e3", "inf", " 4 "):
        n0 = fresh(VOLUME_POST_SL_PAUSE_BARS=env_v)
        rows.append({"env": env_v, "v": volume_scanner.post_sl_pause_bars(), "logs": cap.lines[n0:]})
    out["pause_bars"] = rows
    end_rows = [
        {"progress_stage": "SL", "progress_ts": 100.0, "result": "SL", "state_changed_at": 200.0, "created_at": 50.0},
        {"progress_stage": "sl", "progress_ts": 0, "result": "SL", "state_changed_at": 200.0, "created_at": 50.0},
        {"progress_stage": "", "progress_ts": 100.0, "result": "sl", "state_changed_at": 0.0, "created_at": 50.0},
        {"progress_stage": None, "progress_ts": None, "result": None, "state_changed_at": None, "created_at": None},
        {"progress_stage": "SL", "progress_ts": "123.5", "result": "", "state_changed_at": "x", "created_at": 7},
        {"progress_stage": "SL", "progress_ts": "abc", "result": "SL", "state_changed_at": "300", "created_at": 1},
        {"progress_stage": "TP1", "progress_ts": 100.0, "result": "SL", "state_changed_at": -5.0, "created_at": 9.0},
        {},
    ]
    out["sl_end"] = [{"row": r, "v": volume_scanner._sl_end_ts(r)} for r in end_rows]
    # post_sl_pause_active against the real DB
    _seed_pause_rows()
    rows = []
    for uid, sym, d, tf, env_v in PAUSE_Q:
        n0 = fresh(VOLUME_POST_SL_PAUSE_BARS=env_v)
        res = await volume_scanner.post_sl_pause_active(uid, sym, d, tf, now=T0)
        row = await sp.db_last_signal_outcome(uid, sym, d, "VOLUME")
        rows.append({"q": [uid, sym, d, tf, env_v], "paused": res[0], "why": res[1], "row": row, "logs": cap.lines[n0:]})
    out["pause"] = rows
    out["pause_rows"] = PAUSE_ROWS
    # a failing query → allowed + WARNING (fail-open)
    real = sp.db_last_signal_outcome

    async def boom(*a, **k):
        raise RuntimeError("database is locked")
    sp.db_last_signal_outcome = boom
    n0 = fresh()
    res = await volume_scanner.post_sl_pause_active(7001, "BTC-USDT-SWAP", "LONG", "15m", now=T0)
    sp.db_last_signal_outcome = real
    out["pause_error"] = {"paused": res[0], "why": res[1], "logs": cap.lines[n0:]}
    # gc_sent also drops _pause_logged entries older than 24 h
    volume_scanner._sent_bars.clear()
    volume_scanner._htf_cache.clear()
    volume_scanner._pause_logged.clear()
    for k, ts in (((1, "A", "LONG", "x"), T0 - 10), ((2, "B", "SHORT", "y"), T0 - 86400 - 1),
                  (("min_sl", "C", "LONG", "15m", "z"), T0 - 86400), (("min_sl", "D", "SHORT", "15m", "w"), T0 - 90000)):
        volume_scanner._pause_logged[k] = ts
    F.CLK.t = T0
    volume_scanner.time = TimeProxy()
    gc_ret = volume_scanner.gc_sent()
    volume_scanner.time = F._time
    out["gc_pause"] = {"ret": gc_ret, "left": sorted("|".join(str(p) for p in k) for k in volume_scanner._pause_logged)}
    volume_scanner._pause_logged.clear()

    # save_user_cfg: the [VOL-MIN-VOLUME] storage rule (kv keeps the pre-floor values, round trip)
    from volume_strategy import CONFIG_FIELDS
    key = lambda uid: volume_scanner.KV_CFG_PREFIX + str(uid)  # noqa: E731
    steps = []

    async def step(label, uid, op, arg=None, env=None, pre="__keep__", kv_raise=None):
        n0 = fresh(VOLUME_MIN_SETUP_VOL_MULT=env)
        if pre != "__keep__":
            if pre is None:
                await database.db_kv_delete(key(uid))
            else:
                await database.db_kv_set(key(uid), pre)
        real_get = database.db_kv_get
        if kv_raise:
            async def bad_get(k):
                raise RuntimeError(kv_raise)
            database.db_kv_get = bad_get
        try:
            if op == "toggle":
                d = (await volume_scanner.load_user_cfg(uid)).to_dict()
                d.update(arg)
                await volume_scanner.save_user_cfg(uid, d)
            elif op == "save":
                await volume_scanner.save_user_cfg(uid, dict(arg))
            elif op == "save_noprefs":
                await volume_scanner.save_user_cfg(uid, dict(arg), keep_prefs=False)
            elif op == "reset":
                await volume_scanner.reset_user_cfg(uid)
        finally:
            database.db_kv_get = real_get
        cfg = await volume_scanner.load_user_cfg(uid)
        steps.append({"label": label, "uid": uid, "op": op, "arg": arg, "env": env, "pre": pre, "kv_raise": kv_raise,
                      "kv": await database.db_kv_get(key(uid)), "eff": [cfg.bounce_vol_mult, cfg.ribbon_vol_mult],
                      "logs": cap.lines[n0:]})

    fresh()
    FULL = VolumeConfig().to_dict()           # a full to_dict() (the floored defaults)
    await step("kv 0.8/1.0, HTF toggle", 5300, "toggle", {"use_htf": False},
               pre='{"bounce_vol_mult": 0.8, "ribbon_vol_mult": 1.0, "use_htf": true}')
    await step("then min_quality", 5300, "toggle", {"min_quality": 2})
    await step("then floor off → pre-floor values", 5300, "toggle", {"setup_golden": False}, env="0")
    await step("no kv row + setup toggle", 5301, "toggle", {"setup_ribbon": False}, pre=None)
    await step("genome partial over kv 0.8", 5302, "save", {"bounce_vol_mult": 1.5, "vol_mult": 1.8, "min_quality": 3},
               pre='{"bounce_vol_mult": 0.8}')
    await step("explicit full dict ribbon 2.0", 5303, "save", dict(FULL, ribbon_vol_mult=2.0), pre='{"ribbon_vol_mult": 0.7}')
    await step("explicit full dict exactly the floor over a lower kv (edge)", 5304, "save", dict(FULL, bounce_vol_mult=1.5),
               pre='{"bounce_vol_mult": 0.9, "ribbon_vol_mult": 1.2}')
    await step("kv unreadable during the round trip", 5305, "save", dict(FULL), pre='{"bounce_vol_mult": 0.8}',
               kv_raise="disk I/O error")
    await step("floor off: no kv read, stored as given", 5306, "save", dict(FULL, bounce_vol_mult=1.5), env="0",
               pre='{"bounce_vol_mult": 0.8}')
    await step("kv not a dict", 5307, "toggle", {"use_htf": False}, pre="[1, 2]")
    await step("kv NaN", 5308, "toggle", {"use_htf": False}, pre="NaN")
    await step("env floor 2.0, kv 1.2/1.0", 5309, "toggle", {"use_htf": False}, env="2.0",
               pre='{"bounce_vol_mult": 1.2, "ribbon_vol_mult": 1.0}')
    await step("env floor 2.0, kv 2.5 kept", 5310, "toggle", {"use_htf": False}, env="2.0",
               pre='{"bounce_vol_mult": 2.5, "ribbon_vol_mult": 1.9}')
    await step("min_sl_pct_15m is never stored", 5311, "save", {"min_sl_pct_15m": 3.0, "tp1_rr": 1.2}, pre=None)
    await step("full dict without min_sl_pct_15m is partial", 5312, "save",
               {k: v for k, v in FULL.items() if k != "min_sl_pct_15m"}, pre='{"bounce_vol_mult": 0.8}')
    await step("reset keeps prefs (partial)", 5313, "reset", None, pre='{"bounce_vol_mult": 0.8, "setup_cross": false}')
    await step("kv string values", 5314, "toggle", {"use_htf": False}, pre='{"bounce_vol_mult": "0.6", "ribbon_vol_mult": "x"}')
    await step("kv bounce below 0.3", 5315, "toggle", {"use_htf": False}, pre='{"bounce_vol_mult": 0.1}')
    await step("bad json kv during the round trip", 5316, "save", dict(FULL), pre="{bad")
    out["save_steps"] = steps
    out["config_fields"] = sorted(CONFIG_FIELDS)
    fresh()
    return out


async def main() -> int:
    snap_before = F.tree_snapshot()
    cap = F.capture_logs()
    F.CLK.t = T0
    await database.init_db(os.environ["DB_PATH"])
    out: dict = {}

    # ── helpers ──────────────────────────────────────────────────────────
    out["dedup_ttl"] = {tf: volume_scanner.dedup_ttl_s(tf) for tf in ("15m", "1h", "4h", "1d", "1H", "5m", "", "1w")}
    tf_users = []
    for v in ("15m", "1h", "4h", "1H", "4H", "5m", "1d", "", None):
        u = UserSettings(user_id=1)
        u.vol_timeframe = v
        tf_users.append([v, volume_scanner.user_tf(u)])
    out["user_tf"] = tf_users
    keys = []
    for raw in RAW_CFGS[:4]:
        cfg = VolumeConfig.from_params(json.loads(raw))
        keys.append({"raw": raw, "key": json.dumps(cfg.to_dict(), sort_keys=True), "json": json.dumps(cfg.to_dict())})
    out["cfg_keys"] = keys
    bars = []
    for sym, tf in (("BTC-USDT-SWAP", "15m"), ("BTC-USDT-SWAP", "1h"), ("ETH-USDT-SWAP", "4h"), ("BTC-USDT-SWAP", "1d")):
        df = F.frame_at(sym, tf, T0, 300)
        bars.append([sym, tf, F.ms_of(df.index[-1]), str(df.index[-1])])
    out["bar_ts"] = bars

    # ── load / save / reset_user_cfg ─────────────────────────────────────
    loads = []
    for i, raw in enumerate(RAW_CFGS):
        uid = 5000 + i
        await database.db_kv_set(volume_scanner.KV_CFG_PREFIX + str(uid), raw)
        n0 = len(cap.lines)
        cfg = await volume_scanner.load_user_cfg(uid)
        loads.append({"uid": uid, "raw": raw, "cfg": cfg.to_dict(), "logs": cap.lines[n0:]})
    out["load"] = loads
    saves = []
    for uid, pre, params, keep in (
        (5100, None, {"min_quality": 2, "tp1_rr": 1.25}, True),
        (5101, '{"setup_cross": false, "setup_ribbon": false, "use_htf": false, "min_quality": 5}', {"vol_mult": 2.0}, True),
        (5102, '{"setup_cross": false, "use_htf": false}', {"vol_mult": 2.0, "use_htf": True}, True),
        (5103, '{"setup_cross": false}', {"vol_mult": 2.0}, False),
        (5104, '{bad', {"min_quality": 4}, True),
    ):
        if pre is not None:
            await database.db_kv_set(volume_scanner.KV_CFG_PREFIX + str(uid), pre)
        n0 = len(cap.lines)
        await volume_scanner.save_user_cfg(uid, params, keep_prefs=keep)
        saves.append({"uid": uid, "pre": pre, "params": params, "keep": keep,
                      "kv": await database.db_kv_get(volume_scanner.KV_CFG_PREFIX + str(uid)), "logs": cap.lines[n0:]})
    out["save"] = saves
    resets = []
    for uid, pre, keep in (
        (5200, '{"setup_cross": false, "setup_golden": false, "min_quality": 5, "vol_mult": 3.0}', True),
        (5201, '{"min_quality": 5, "vol_mult": 3.0}', True),
        (5202, '{"setup_cross": false, "min_quality": 5}', False),
        (5203, None, True),
    ):
        if pre is not None:
            await database.db_kv_set(volume_scanner.KV_CFG_PREFIX + str(uid), pre)
        n0 = len(cap.lines)
        await volume_scanner.reset_user_cfg(uid, keep_prefs=keep)
        resets.append({"uid": uid, "pre": pre, "keep": keep,
                       "kv": await database.db_kv_get(volume_scanner.KV_CFG_PREFIX + str(uid)), "logs": cap.lines[n0:]})
    out["reset"] = resets

    # ── gc_sent ──────────────────────────────────────────────────────────
    volume_scanner._sent_bars.clear()
    volume_scanner._htf_cache.clear()
    df = F.frame_at("BTC-USDT-SWAP", "4h", T0, 60)
    for k, ts in (((1, "A", "LONG", "x"), T0 - 10), ((2, "B", "SHORT", "y"), T0 - 86400 - 1), ((3, "C", "LONG", "z"), T0 - 86400),
                  ((4, "D", "LONG", "w"), T0 - 90000)):
        volume_scanner._sent_bars[k] = ts
    for k, ts in ((("A", "4h"), T0 - 179), (("B", "1d"), T0 - 181), (("C", "4h"), T0 - 180)):
        volume_scanner._htf_cache[k] = (ts, df)
    gc_ret = volume_scanner.gc_sent()
    out["gc"] = {"ret": gc_ret, "sent_bars": {"|".join(str(p) for p in k): v for k, v in volume_scanner._sent_bars.items()},
                 "htf": sorted(f"{k[0]}|{k[1]}" for k in volume_scanner._htf_cache)}

    # ── wake event ───────────────────────────────────────────────────────
    wake = []
    for tf in ("15m", "1H", "4H", "1D", "1h", "4h", "1m", "", "1W"):
        volume_scanner._wake_event().clear()
        await volume_scanner._on_ws_bar_close("BTC-USDT-SWAP", tf)
        wake.append([tf, volume_scanner._wake_event().is_set()])
    volume_scanner._wake_event().clear()
    out["wake"] = wake

    # ── run_volume_scanner ───────────────────────────────────────────────
    plan = ["ok", "raise", "raise", "ok_wake", "timeout", "ok", "raise", "cancel"]
    st = {"i": 0}
    sleeps, waits, beats = [], [], []

    async def stub_cycle(bot, um, fetcher):
        step = plan[st["i"]]
        st["i"] += 1
        if step in ("ok", "ok_wake"):
            F.CLK.t += 4.0
            if step == "ok_wake":
                await volume_scanner._on_ws_bar_close("BTC-USDT-SWAP", "1H")
        elif step == "raise":
            F.CLK.t += 1.0
            raise RuntimeError("boom")

    class Proxy:
        def __getattr__(self, name):
            return getattr(REAL_ASYNCIO, name)

        async def sleep(self, d, *a, **k):
            sleeps.append(d)
            F.CLK.t += d
            await REAL_ASYNCIO.sleep(0)

        async def wait_for(self, aw, timeout=None):
            name = getattr(getattr(aw, "cr_code", None), "co_name", "")
            if name in ("_scan_cycle", "stub_cycle"):
                step = plan[st["i"]]
                if step == "timeout":
                    st["i"] += 1
                    aw.close()
                    F.CLK.t += timeout
                    raise REAL_ASYNCIO.TimeoutError()
                if step == "cancel":
                    st["i"] += 1
                    aw.close()
                    raise REAL_ASYNCIO.CancelledError()
                return await REAL_ASYNCIO.wait_for(aw, timeout)
            # evt.wait() with the rest of the interval
            evt = volume_scanner._wake_event()
            waits.append([timeout, evt.is_set()])
            if evt.is_set():
                return await REAL_ASYNCIO.wait_for(aw, timeout)
            aw.close()
            F.CLK.t += timeout
            raise REAL_ASYNCIO.TimeoutError()

    real_cycle = volume_scanner._scan_cycle
    volume_scanner._scan_cycle = stub_cycle
    volume_scanner.asyncio = Proxy()
    volume_scanner.time = TimeProxy()
    import ws_feed
    registered = []
    real_reg = ws_feed.register_on_bar_close
    ws_feed.register_on_bar_close = lambda cb: registered.append(getattr(cb, "__name__", "?"))
    n0 = len(cap.lines)
    F.CLK.t = T0 + 1000
    t_start = F.CLK.t
    await volume_scanner.run_volume_scanner(None, None, None, health=types.SimpleNamespace(heartbeat=lambda n: beats.append(n)),
                                            interval_sec=60)
    ws_feed.register_on_bar_close = real_reg
    volume_scanner._scan_cycle = real_cycle
    volume_scanner.asyncio = REAL_ASYNCIO
    volume_scanner.time = F._time
    out["loop"] = {"start": t_start, "end": F.CLK.t, "plan": plan, "sleeps": sleeps, "waits": waits, "beats": beats,
                   "registered": registered, "logs": cap.lines[n0:], "wake_set": volume_scanner._wake_event().is_set()}

    out["batch_d"] = await batch_d(cap)

    doc = {"meta": {"generator": "tests/engine/scanners/py/volume_units.py", "python": sys.version.split()[0]},
           "t0": T0, "out": out}
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
