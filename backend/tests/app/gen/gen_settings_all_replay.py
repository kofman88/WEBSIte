"""gen_settings_all_replay.py — tests/app/fixtures/settings_all_replay.json (settingsReplay.test.js):
the adversarial `settings/all` payloads of settings_all_cases.json replayed through the bot's
miniapp_api.h_settings_all_post with a fake user (no DB, no Telegram); every case gets the status /
body / resulting user state the bot produced as `expected`.

    cd /home/user/MAIN_BOT/CHM_BREAKER_V4
    BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <prod-like venv, python 3.11>/bin/python -I \
        <site>/backend/tests/app/gen/gen_settings_all_replay.py [OUT]      # OUT defaults to tests/app/fixtures/settings_all_replay.json
    rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
import asyncio, json, sys, time
import os
BOT = os.environ.get("GOLDEN_BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
sys.dont_write_bytecode = True
sys.path.insert(0, BOT)
os.chdir(BOT)
import miniapp_api as api
import volume_scanner as vs
from volume_strategy import VolumeConfig
from user_manager import UserSettings

NOW = time.time()
STATE_KEYS = [
    "long_tf", "short_tf", "min_quality", "min_volume_usdt", "min_rr", "max_dist_pct", "zone_pct",
    "use_rsi", "use_volume", "use_htf", "trend_only", "max_risk_pct",
    "smc_cfg", "smc_max_sl_pct", "smc_long_active", "smc_short_active",
    "vol_timeframe", "auto_trade", "auto_trade_mode", "trade_exchange", "trade_risk_pct", "trade_leverage",
    "max_trades_limit", "risk_mode", "partial_tp_enabled", "auto_trailing_enabled", "prefer_market_entry", "bybit_demo",
    "sl_streak_enabled", "sl_streak_threshold", "circuit_breaker_enabled", "circuit_breaker_threshold_r",
    "allow_counter_trend", "filters_all_off", "btc_correlation_block", "spread_check_enabled",
    "trade_trending_only", "hour_filter_enabled",
    "progress_notify_enabled", "send_chart_enabled", "signal_format", "quiet_start", "quiet_end",
    "lang", "ui_mode", "genome_auto_apply", "sub_plan", "sub_status",
]

CASES = json.load(open(os.path.join(HERE, "settings_all_cases.json"), encoding="utf-8"))


class FakeUM:
    def __init__(self):
        self.saved = 0

    async def save(self, user):
        self.saved += 1

    async def get_or_create(self, *a, **k):
        raise RuntimeError("not used")


class FakeReq:
    method = "POST"


def make_user(spec):
    uid = 123 if spec.get("admin") else 1
    u = UserSettings(user_id=uid)
    if spec.get("plan") == "pro":
        u.sub_plan, u.sub_status, u.sub_expires = "pro", "active", NOW + 30 * 86400
    else:
        u.sub_plan, u.sub_status, u.sub_expires = "free", "active", NOW + 365 * 86400
    for k, v in (spec.get("attrs") or {}).items():
        setattr(u, k, v)
    return u


async def run_case(case):
    user = make_user(case.get("user") or {})
    um = FakeUM()
    store = {"cfg": VolumeConfig.from_params(case.get("user", {}).get("volume_cfg") or {}).to_dict(), "saved": []}
    side = []

    async def _load_user(request):
        return {"id": user.user_id, "username": ""}, user

    async def _read_body(request):
        b = case["body"]
        return b if isinstance(b, dict) else {}

    async def load_user_cfg(uid):
        return VolumeConfig.from_params(store["cfg"])

    async def save_user_cfg(uid, params, keep_prefs=True):
        params = dict(params or {})
        if keep_prefs and any(k not in params for k in vs.USER_PREF_KEYS):
            cur = await load_user_cfg(uid)
            for k in vs.USER_PREF_KEYS:
                params.setdefault(k, getattr(cur, k))
        cfg = VolumeConfig.from_params(params)
        store["cfg"] = cfg.to_dict()
        store["saved"].append(True)

    api._load_user = _load_user
    api._read_body = _read_body
    api._ctx["um"] = um
    vs.load_user_cfg = load_user_cfg
    vs.save_user_cfg = save_user_cfg
    try:
        import bybit_trader
        bybit_trader.invalidate_pybit_session = lambda key: side.append("invalidate_bybit_session")
    except Exception as e:  # pragma: no cover
        print("bybit_trader import failed:", e, file=sys.stderr)
    try:
        import auto_trade
        auto_trade.reset_auth_failures = lambda uid, ex: side.append(f"reset_auth_failures:{ex}")
    except Exception as e:  # pragma: no cover
        print("auto_trade import failed:", e, file=sys.stderr)

    resp = await api.h_settings_all_post(FakeReq())
    body = json.loads(resp.text)
    out = {"status": resp.status, "ok": body.get("ok"), "error": body.get("error"), "message": body.get("message"),
           "saved": um.saved > 0}
    state = {k: getattr(user, k) for k in STATE_KEYS}
    out["state"] = state
    out["volume_cfg"] = store["cfg"]
    out["volume_saved"] = len(store["saved"]) > 0
    out["side_effects"] = side
    if body.get("ok"):
        s = body["settings"]
        out["settings_miniapp"] = {
            "lang": s["lang"], "ui_mode": s["ui_mode"],
            "levels": {k: s["levels"][k] for k in api._SCHEMA["levels"]},
            "smc": {k: s["smc"][k] for k in api._SCHEMA["smc"]},
            "volume": {k: s["volume"][k] for k in api._SCHEMA["volume"]},
            "trading": {k: s["trading"][k] for k in api._SCHEMA["trading"]},
            "risk": {k: s["risk"][k] for k in api._SCHEMA["risk"]},
            "notifications": {k: s["notifications"][k] for k in api._SCHEMA["notifications"]},
            "genome_auto_apply": s["genome_auto_apply"],
        }
    return out


async def main():
    results = []
    for case in CASES:
        res = await run_case(case)
        results.append({**case, "expected": res})
    json.dump(results, open(os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, '../fixtures/settings_all_replay.json'), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(len(results), "cases")


asyncio.run(main())
