"""gen_bot_vectors.py — tests/engine/fixtures/bot_vectors.json (botVectors.test.js): vectors from the
bot's Python for
  - miniapp_api._apply_multi (every primary × extras × direction-flags × on/off combo),
  - user_manager._sparse_merge on random override dicts (legacy and sparse),
  - UserSettings.grant_access / check_access / normalize_plan / enabled_strategies.

    cd /home/user/MAIN_BOT/CHM_BREAKER_V4
    BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <prod-like venv, python 3.11>/bin/python -I \
        <site>/backend/tests/engine/gen/gen_bot_vectors.py [OUT]      # OUT defaults to tests/engine/fixtures/bot_vectors.json
    rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
import json, random, sys, time, itertools
import os
BOT = os.environ.get("GOLDEN_BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
sys.dont_write_bytecode = True
sys.path.insert(0, BOT)
os.chdir(BOT)
from dataclasses import asdict, fields
import miniapp_api as api
import user_manager as um
from config import normalize_plan, parse_strategies, enabled_strategies

random.seed(20261008)
out = {}

# ── (3) _apply_multi truth table ────────────────────────────────────────────
STRATS = ("LEVELS", "SMC", "VOLUME")
cases = []
for primary in STRATS + ("", "BOGUS"):
    for extras in ("", "SMC", "VOLUME", "SMC,VOLUME", "LEVELS,SMC", "volume, smc", "LEVELS"):
        for pflags in ((False, False), (True, False), (False, True), (True, True)):
            for s in STRATS:
                for on in (True, False):
                    u = um.UserSettings(user_id=1)
                    u.strategy = primary
                    u.extra_strategies = extras
                    f = api._FLAGS.get(primary)
                    if f:
                        setattr(u, f[0], pflags[0]); setattr(u, f[1], pflags[1])
                    api._apply_multi(u, s, on)
                    cases.append({"primary": primary, "extras": extras, "pflags": list(pflags), "s": s, "on": on,
                                  "strategy": u.strategy, "extra_strategies": u.extra_strategies})
out["apply_multi"] = cases

# ── (3b) h_strategy flow: flags set then _apply_multi, mutex / lock gates ─────
flow = []
for plan in ("free", "pro"):
    for primary in STRATS:
        for s in STRATS:
            for want in ((True, False), (False, True), (True, True), (False, False)):
                u = um.UserSettings(user_id=1)
                u.sub_plan, u.sub_status, u.sub_expires = plan, "active", time.time() + 86400 * 30
                u.strategy = primary
                lf, sf = api._FLAGS[primary]
                setattr(u, lf, True)
                locked = api._strategy_locked(u, s)
                mutex = u.is_mutual_exclusion_required()
                res = None
                if (want[0] or want[1]) and locked:
                    res = "pro_required_locked"
                elif want[0] and want[1] and mutex:
                    res = "pro_required_mutex"
                else:
                    lf2, sf2 = api._FLAGS[s]
                    setattr(u, lf2, want[0]); setattr(u, sf2, want[1])
                    api._apply_multi(u, s, want[0] or want[1])
                    if want[0] or want[1]:
                        u.active = True
                    res = "ok"
                flow.append({"plan": plan, "primary": primary, "s": s, "want": list(want), "result": res,
                             "strategy": u.strategy, "extra_strategies": u.extra_strategies,
                             "flags": {k: getattr(u, k) for k in ("long_active", "short_active", "smc_long_active", "smc_short_active", "vol_long_active", "vol_short_active", "active")},
                             "strategies": api._strategies(u),
                             "enabled": sorted(enabled_strategies(u))})
out["strategy_flow"] = flow

# ── (4) _sparse_merge on random dicts ───────────────────────────────────────
F = [(f.name, f.type) for f in fields(um.TradeCfg)]
defaults = asdict(um.TradeCfg())

def rand_val(name, typ):
    d = defaults[name]
    r = random.random()
    if typ is bool:
        return random.choice([True, False, 0, 1])
    if typ is str:
        return random.choice(["1h", "15m", "4h", d])
    if typ is int:
        return random.choice([d, d, d + 1, 0, -3, 999, float(d), d + 0.0])
    # float
    return random.choice([d, d, d + 1e-10, d + 1e-7, d * (1 + 5e-7), 0.0, 0.5, 7.25, int(d), -1.0, d + 0.3])

merges = []
for i in range(40):
    base = {}
    for name, typ in F:
        base[name] = rand_val(name, typ) if random.random() < 0.5 else defaults[name]
    base_cfg = um.TradeCfg(**base)
    raw = {}
    for name, typ in F:
        if random.random() < 0.4:
            raw[name] = rand_val(name, typ)
    if random.random() < 0.3:
        raw["unknown_key"] = 5
    sparse = random.random() < 0.5
    if sparse:
        raw["_sparse"] = random.choice([True, 1, "yes"])
    elif random.random() < 0.3:
        raw["_sparse"] = random.choice([False, 0, "", None])
    override_json = json.dumps(raw)
    merged = um._sparse_merge(base_cfg, override_json)
    merges.append({"base": asdict(base_cfg), "override_json": override_json, "merged": asdict(merged),
                   "merged_json": merged.to_json()})
# edge: invalid JSON, empty, legacy full dump equal to defaults
for oj in ("", "{}", "not json", '{"min_rr": 0.5, "tp1_rr": 1.0, "tp2_rr": 1.0, "tp3_rr": 1.0}',
           json.dumps(asdict(um.TradeCfg())), json.dumps({**asdict(um.TradeCfg()), "_sparse": True})):
    base_cfg = um.TradeCfg(min_rr=3.0, tp1_rr=3.5, zone_pct=1.35, min_quality=7)
    merged = um._sparse_merge(base_cfg, oj)
    merges.append({"base": asdict(base_cfg), "override_json": oj, "merged": asdict(merged), "merged_json": merged.to_json()})
out["sparse_merge"] = merges

# _load_sparse / _save_sparse / _update_long_field round-trips (handlers/_common)
from handlers._common import _load_sparse, _save_sparse, _update_long_field
ls = []
for m in merges[:25]:
    ls.append({"raw": m["override_json"], "loaded": _load_sparse(m["override_json"]), "saved": _save_sparse(_load_sparse(m["override_json"]))})
upd = []
for m in merges[:15]:
    u = um.UserSettings(user_id=1)
    u.long_cfg = m["override_json"]
    _update_long_field(u, "min_rr", 2.5)
    _update_long_field(u, "use_rsi", False)
    _update_long_field(u, "min_volume_usdt", 1000000.0)
    upd.append({"raw": m["override_json"], "long_cfg": u.long_cfg, "long_cfg_eff": asdict(u.get_long_cfg())})
out["load_sparse"] = ls
out["update_long"] = upd

# ── (5) grant_access / check_access / normalize_plan ────────────────────────
NOW = 1_800_000_000.0
import time as _time
_real_time = _time.time
_time.time = lambda: NOW
ga = []
for status in ("expired", "active", "trial", "banned", "weird"):
    for plan_ in ("free", "pro", "elite", "beginner", "starter", "", "PRO ", None):
        for exp in (0.0, NOW - 100, NOW + 100, NOW + 10 * 86400):
            for days in (30, 365, 0):
                u = um.UserSettings(user_id=1)
                u.sub_status, u.sub_plan, u.sub_expires = status, plan_, exp
                u.expired_notified = u.reminder_3d_sent = u.reminder_1d_sent = True
                ok = u.grant_access(days)
                ga.append({"status": status, "plan": plan_, "expires": exp, "days": days, "ok": ok,
                           "sub_expires": u.sub_expires, "sub_status": u.sub_status,
                           "flags": [u.expired_notified, u.reminder_3d_sent, u.reminder_1d_sent]})
out["grant_access"] = ga
ca = []
for status in ("expired", "active", "trial", "banned", "weird"):
    for plan_ in ("free", "pro", "elite", "starter"):
        for exp in (0.0, NOW - 1, NOW + 1):
            for flags in ((False, False), (True, False)):
                for vol in (False, True):
                    for uid in (1, 123):
                        u = um.UserSettings(user_id=uid)
                        u.sub_status, u.sub_plan, u.sub_expires = status, plan_, exp
                        u.long_active, u.short_active = flags
                        u.vol_long_active = vol
                        u.strategy = "VOLUME" if vol else "SMC"
                        res = u.check_access()
                        ca.append({"status": status, "plan": plan_, "expires": exp, "flags": list(flags), "vol": vol, "uid": uid,
                                   "result": list(res), "after": {"sub_status": u.sub_status, "sub_plan": u.sub_plan,
                                   "long_active": u.long_active, "short_active": u.short_active,
                                   "vol_long_active": u.vol_long_active, "strategy": u.strategy},
                                   "is_pro": api._is_pro(um.UserSettings(user_id=uid, sub_status=status, sub_plan=plan_, sub_expires=exp))})
out["check_access"] = ca
out["normalize_plan"] = {str(p): normalize_plan(p) for p in ("free", "pro", "elite", "beginner", "starter", "", " Pro ", "PRO", "Elite", None, 0, "freeish")}
out["parse_strategies"] = {s: parse_strategies(s) for s in ("", "SMC", "smc, volume", "VOLUME,LEVELS,SMC,SMC", " levels ,x,", "LEVELS,,SMC", None)}
_time.time = _real_time
json.dump(out, open(os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, '../fixtures/bot_vectors.json'), "w", encoding="utf-8"), ensure_ascii=False)
print({k: len(v) for k, v in out.items()})
