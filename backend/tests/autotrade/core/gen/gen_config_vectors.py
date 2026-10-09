"""CPython 3.11 reference for services/autotrade/config.js: the bot's config.Config values that
execute_auto_trade reads, for a set of environments. Each environment imports the bot's own
config.py in a fresh interpreter (Config attributes are evaluated once, at import); an import
failure is recorded as (exception type, message).

Run from the bot tree with the production interpreter:
  cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \
    $PY311 -I -B tests/autotrade/core/gen/gen_config_vectors.py
Output: tests/autotrade/core/fixtures/config_vectors.json
"""
import json
import os
import subprocess
import sys

PROBE = r"""
import json, sys
sys.path.insert(0, '.')
try:
    from config import Config as C
    print(json.dumps({"ok": {
        "SMC_HOUR_FILTER_ENABLED": C.SMC_HOUR_FILTER_ENABLED,
        "SMC_HOUR_FILTER_MODE": C.SMC_HOUR_FILTER_MODE,
        "BAD_HOURS_UTC": {"SMC": C.BAD_HOURS_UTC["SMC"]},
        "DAILY_MAX_LOSS_R": C.DAILY_MAX_LOSS_R,
    }}))
except Exception as e:
    print(json.dumps({"err": [type(e).__name__, str(e)]}))
"""

ENVS = [
    {},
    {"SMC_HOUR_FILTER_ENABLED": "0"},
    {"SMC_HOUR_FILTER_ENABLED": " 1 "},
    {"SMC_HOUR_FILTER_ENABLED": "true"},
    {"SMC_HOUR_FILTER_MODE": "shadow"},
    {"SMC_HOUR_FILTER_MODE": " Shadow "},
    {"SMC_HOUR_FILTER_MODE": "OFF"},
    {"SMC_HOUR_FILTER_MODE": "block"},
    {"SMC_HOUR_FILTER_MODE": ""},
    {"SMC_BAD_HOURS_UTC": "1,2, 3"},
    {"SMC_BAD_HOURS_UTC": "0,23"},
    {"SMC_BAD_HOURS_UTC": "1,x"},
    {"SMC_BAD_HOURS_UTC": "24"},
    {"SMC_BAD_HOURS_UTC": "-1"},
    {"SMC_BAD_HOURS_UTC": "   "},
    {"SMC_BAD_HOURS_UTC": "5,"},
    {"SMC_BAD_HOURS_UTC": "07"},
    {"DAILY_MAX_LOSS_R": "2.5"},
    {"DAILY_MAX_LOSS_R": " 10 "},
    {"DAILY_MAX_LOSS_R": "1e1"},
    {"DAILY_MAX_LOSS_R": "-3"},
    {"DAILY_MAX_LOSS_R": "x"},
    {"DAILY_MAX_LOSS_R": ""},
]


def main():
    assert sys.version_info[:2] == (3, 11), sys.version
    out = []
    keys = ("SMC_HOUR_FILTER_ENABLED", "SMC_HOUR_FILTER_MODE", "SMC_BAD_HOURS_UTC", "DAILY_MAX_LOSS_R")
    for env in ENVS:
        e = {k: v for k, v in os.environ.items() if k not in keys}
        e.update(env)
        r = subprocess.run([sys.executable, "-I", "-B", "-c", PROBE], env=e, capture_output=True, text=True, timeout=120)
        line = [ln for ln in r.stdout.splitlines() if ln.startswith("{")]
        if not line:
            raise SystemExit(f"probe failed for {env}: rc={r.returncode} {r.stderr[-500:]}")
        out.append({"env": env, **json.loads(line[-1])})
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(os.path.dirname(here), "fixtures", "config_vectors.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"python": sys.version.split()[0], "cases": out}, fh, ensure_ascii=False, indent=1)
    print(f"wrote {len(out)} cases → {path}")


if __name__ == "__main__":
    main()
