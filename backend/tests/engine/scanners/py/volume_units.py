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
