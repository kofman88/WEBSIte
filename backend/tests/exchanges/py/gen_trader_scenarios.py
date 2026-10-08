"""Run the replay scenarios through the bot's traders and write the JS fixtures.

  cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \
    $VENV/bin/python /path/to/backend/tests/exchanges/py/gen_trader_scenarios.py [bybit bingx binance okx]; \
    rm -f signal_registry.json

Writes ../fixtures/scenarios_<exchange>.json: [{scenario, expected}] where each route
response carries the exact text the fake served (so JS replays identical bytes).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import harness  # noqa: E402


def _freeze_routes(sc):
    out = dict(sc)
    routes = []
    for r in sc.get("routes", []):
        rr = dict(r)
        resps = []
        for x in r["responses"]:
            x = dict(x)
            if "json" in x:
                x["text"] = json.dumps(x.pop("json"))
            resps.append(x)
        rr["responses"] = resps
        routes.append(rr)
    out["routes"] = routes
    return out


def main(which):
    for ex in which:
        mod = __import__(f"scen_{ex}")
        rows = []
        for sc in mod.SCENARIOS:
            frozen = _freeze_routes(sc)
            # the harness consumes 'json' or 'text'; feed it the frozen text form
            res = harness.run_scenario(json.loads(json.dumps(frozen)))
            rows.append({"scenario": frozen, "expected": res})
            r0 = res.get("result")
            status = "raised" if "raised" in res else ("ok" if isinstance(r0, dict) and r0.get("ok") else ("fail" if isinstance(r0, dict) else "value"))
            print(f"{ex:8s} {sc['name']:40s} {status:6s} reqs={len(res['requests'])}")
        path = os.path.join(HERE, "..", "fixtures", f"scenarios_{ex}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=1)
        print("wrote", path)


if __name__ == "__main__":
    main(sys.argv[1:] or ["bybit", "bingx", "binance", "okx"])
