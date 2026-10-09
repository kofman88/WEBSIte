"""gen_rate_limits.py — tests/app/fixtures/rate_limits.json (rateLimits.test.js): every per-user limit
and quota of the bot's Mini App API as miniapp_api defines it (CPython 3.11, default env), plus the
exact 429 the bucket helpers answer, so the site's buckets can be checked against the bot's numbers.

    cd /home/user/MAIN_BOT/CHM_BREAKER_V4
    BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <python 3.11 venv>/bin/python -I \
        <site>/backend/tests/app/gen/gen_rate_limits.py [OUT]
    rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
import json, os, sys

BOT = os.environ.get("GOLDEN_BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
for k in ("MINIAPP_POST_PER_MIN", "MINIAPP_CHART_PER_MIN", "MINIAPP_POSITIONS_PER_MIN"):
    os.environ.pop(k, None)
sys.dont_write_bytecode = True
sys.path.insert(0, BOT)
os.chdir(BOT)
import miniapp_api as api


def resp(e):
    return {"status": e.status, "retry_after": e.headers.get("Retry-After"), "content_type": e.content_type,
            "json": json.loads(e.text)}


def bucket_trace(limit, window, times):
    """_rate_ok over a hit sequence at the given clock times (time.time patched)."""
    import time as _t
    api._RATE.clear()
    out = []
    real = _t.time
    try:
        for t in times:
            _t.time = lambda t=t: t
            out.append(api._rate_ok(1, "probe", limit, window))
    finally:
        _t.time = real
        api._RATE.clear()
    return out


doc = {
    "python": sys.version.split()[0],
    "buckets": {
        "post": list(api.POST_RATE_LIMIT), "keys": list(api.KEYS_RATE_LIMIT), "positions": list(api.POSITIONS_RATE_LIMIT),
        "chart": list(api.CHART_RATE_LIMIT), "plan": list(api.PLAN_RATE_LIMIT), "share": list(api.SHARE_RATE_LIMIT),
    },
    "feedback_per_day": api._FEEDBACK_PER_DAY,
    "analyze_cooldown_s": api._ANALYZE_COOLDOWN_S,
    "rate_limited_10": resp(api._rate_limited_response(10)),
    "rate_limited_6": resp(api._rate_limited_response(6)),
    # 10 hits in 60 s at t = 0..9, then the 11th at 9.5, at 59.999 and at 60.0 (the window is `now - t < window`)
    "trace": {"limit": 10, "window": 60.0, "times": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9.5, 59.999, 60.0, 60.5, 61.0],
              "ok": bucket_trace(10, 60.0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9.5, 59.999, 60.0, 60.5, 61.0])},
}
dst = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "..", "fixtures", "rate_limits.json")
with open(dst, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=True, indent=1)
print("ok", doc["buckets"])
