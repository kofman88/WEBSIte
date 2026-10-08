"""gen_routes_replay.py — tests/app/fixtures/routes_replay.json (routesReplay.test.js): the payloads of
route_cases.json replayed through the bot's miniapp_api h_settings (prefs), h_strategy, h_profile and
h_lang with a fake user; every case gets the status / body / user state the bot produced as `expected`.

    cd /home/user/MAIN_BOT/CHM_BREAKER_V4
    BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <prod-like venv, python 3.11>/bin/python -I \
        <site>/backend/tests/app/gen/gen_routes_replay.py [OUT]      # OUT defaults to tests/app/fixtures/routes_replay.json
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
STATE_KEYS = ["strategy", "extra_strategies", "active", "scan_mode", "long_active", "short_active", "smc_long_active",
              "smc_short_active", "vol_long_active", "vol_short_active", "progress_notify_enabled", "send_chart_enabled",
              "genome_auto_apply", "signal_format", "quiet_start", "quiet_end", "lang", "min_quality",
              "trade_risk_pct", "trade_leverage", "max_trades_limit", "auto_trade_mode", "allow_counter_trend",
              "levels_counter_trend_min_quality"]
CASES = json.load(open(os.path.join(HERE, "route_cases.json"), encoding="utf-8"))


class FakeUM:
    def __init__(self):
        self.saved = 0

    async def save(self, user):
        self.saved += 1


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
    store = {"cfg": VolumeConfig().to_dict()}

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
        store["cfg"] = VolumeConfig.from_params(params).to_dict()

    api._load_user = _load_user
    api._read_body = _read_body
    api._ctx["um"] = um
    vs.load_user_cfg = load_user_cfg
    vs.save_user_cfg = save_user_cfg
    handler = {"settings": api.h_settings, "strategy": api.h_strategy, "profile": api.h_profile, "lang": api.h_lang}[case["route"]]
    resp = await handler(FakeReq())
    body = json.loads(resp.text)
    out = {"status": resp.status, "ok": body.get("ok"), "error": body.get("error"), "message": body.get("message"),
           "saved": um.saved > 0, "state": {k: getattr(user, k) for k in STATE_KEYS}, "volume_cfg": store["cfg"]}
    for k in ("prefs", "strategy", "strategies", "profile", "applied", "skipped", "lang"):
        if k in body:
            out[k] = body[k]
    return out


async def main():
    results = []
    for case in CASES:
        results.append({**case, "expected": await run_case(case)})
    json.dump(results, open(os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, '../fixtures/routes_replay.json'), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(len(results), "cases")


asyncio.run(main())
