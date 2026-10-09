"""CPython 3.11 reference for services/autotrade/pyfmt.js.

`fmt % args` (logging's msg % args — every auto-trade log line) and `tpl.format(**kwargs)`
(i18n._t — every user message) on the value shapes execute_auto_trade formats: ints, integral
and fractional floats, bools, None, str (ASCII / Cyrillic / quotes), lists, dicts. Errors are
recorded as (type name, str(e)).

Encoding: a Python float is {"f": x} ({"f": "nan" | "inf" | "-inf"} for the specials) so the JS
side can rebuild the int / float distinction; everything else is plain JSON.

Run (production interpreter, from the bot tree, nothing of the bot imported):
  cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \
    $PY311 -I -B tests/autotrade/core/gen/gen_pyfmt_vectors.py
Output: tests/autotrade/core/fixtures/pyfmt_vectors.json (next to this directory).
"""
import json
import math
import os
import sys


def enc(v):
    if isinstance(v, bool) or v is None or isinstance(v, (int, str)):
        return v
    if isinstance(v, float):
        if math.isnan(v):
            return {"f": "nan"}
        if math.isinf(v):
            return {"f": "inf" if v > 0 else "-inf"}
        return {"f": v}
    if isinstance(v, (list, tuple)):
        return [enc(x) for x in v]
    if isinstance(v, dict):
        return {"d": [[k, enc(x)] for k, x in v.items()]}
    raise TypeError(type(v))


PF = [
    ("%s", (1,)), ("%s", (1.0,)), ("%s", (1.5,)), ("%s", ("x",)), ("%s", (None,)), ("%s", (True,)),
    ("%s", ([1, "a", 2.0, None],)), ("%s", ({"a": 1, "b": 2.5, "c": "x"},)), ("%s", (0.1 + 0.2,)),
    ("%s", (1e16,)), ("%s", (1e-05,)), ("%s", (123456789.0,)), ("%s", (-0.0,)), ("%s", (float("nan"),)),
    ("%s", (float("inf"),)), ("%s", ([4, 18, 19, 20, 22],)), ("%s", ("привет",)),
    ("%d", (3.7,)), ("%d", (True,)), ("%d", (-2.5,)), ("%d", (10,)), ("%i", (7,)),
    ("%.2f", (1,)), ("%.2f", (2.675,)), ("%.2f", (1e-07,)), ("%.2f", (-0.0,)), ("%.2f", (True,)),
    ("%.4f%%", (1.23456,)), ("%.1f%%", (99.95,)), ("%.0f", (0.5,)), ("%.0f", (1.5,)), ("%.0f", (2.5,)),
    ("%.6f", (0.000123456789,)), ("%.3f", (1234567.0005,)), ("%f", (1.0,)), ("%.8f", (0.1,)),
    ("%r", ("a'b",)), ("%r", ('a"b',)), ("%r", ("a'b\"c",)), ("%r", ("привет",)), ("%r", (None,)),
    ("%r", (3.0,)), ("%r", ([1, 2],)), ("%r", ("hour_utc=4 in bad_hours=[4, 18]",)), ("%r", ("",)),
    ("%5.1f|%-6s|%06.2f", (3.14159, "ab", 3.14159)), ("%3d|%-3d|%03d", (5, 5, 5)), ("%+d", (5,)),
    ("% d", (5,)), ("%+.2f", (-1.5,)), ("%10s|", ("abc",)), ("%-10s|", ("abc",)), ("%.3s", ("abcdef",)),
    ("%x", (255,)), ("%e", (12345.678,)), ("%.2e", (0.000123,)), ("%g", (0.0001234,)), ("%g", (1e20,)),
    ("%.3g", (1234.5,)), ("%g", (100.0,)), ("%g", (1.5,)), ("%G", (1e-10,)),
    ("100%%", ()), ("%s %s %s", (1, 2.0, "3")), ("uid=%s sym=%s: %.2f%% capped to %.2f%%", (501, "SOL-USDT-SWAP", 3.0, 2.0)),
    ("[RISK-CAP] uid=%d sym=%s: trade_risk=%.2f%% capped", (501.0, "BTC", 5)),
    # ints stay inside 2**53 (JS numbers): uids, timestamps, counts — order ids are strings
    ("%s", (2 ** 53,)), ("%d", (9007199254740991,)), ("%.2f", (1e22,)), ("%s", (1e22,)), ("%d", (1e22,)),
    ("%d", (float("nan"),)), ("%d", (float("inf"),)), ("%G", (1.5e-10,)), ("%E", (12345.678,)),
    ("%d", ("x",)), ("%.2f", ("x",)), ("%.2f", (None,)), ("%s %s", (1,)), ("%s", (1, 2)),
]

SF = [
    ("{a}", {"a": 1.0}), ("{a}", {"a": 1}), ("{a}", {"a": 2.5}), ("{a}", {"a": None}), ("{a}", {"a": True}),
    ("{a}", {"a": [1, 2.0]}), ("{a}", {"a": "текст"}), ("{a:.2f}", {"a": 2.5}), ("{a:.2f}", {"a": 3}),
    ("{a:.1f}", {"a": 0.05}), ("{a:.0f}", {"a": 2.5}), ("{a:,}", {"a": 1234567}), ("{a:,.2f}", {"a": 1234567.891}),
    ("{a:,.0f}", {"a": 999.5}), ("{a:>5}", {"a": "x"}), ("{a:<5}|", {"a": "x"}), ("{a:^7}|", {"a": "ab"}),
    ("{a:5}|", {"a": 42}), ("{a:5}|", {"a": "ab"}), ("{a:+.1f}", {"a": 3}), ("{a:+.1f}", {"a": -3}),
    ("{a:d}", {"a": 7}), ("{a:,d}", {"a": 1234567}), ("{a:.0%}", {"a": 0.256}), ("{a:.1%}", {"a": 0.0125}),
    ("{a:05.1f}", {"a": 3.14159}), ("{a:05.1f}", {"a": -3.14159}), ("{a:g}", {"a": 1e-05}), ("{a:g}", {"a": 123.0}),
    ("{a:e}", {"a": 12345.678}), ("{a:.3}", {"a": "abcdef"}), ("{a:.3}", {"a": 3.14159}), ("{a:.2}", {"a": 1234.5}),
    ("{{lit}} {a}", {"a": 1}), ("{a}{b}", {"a": "x", "b": 2.0}), ("{a:.2f}$", {"a": 1e-07}),
    ("{missing}", {"a": 1}), ("{a:d}", {"a": 1.5}), ("{a:d}", {"a": 1.0}), ("x { y", {}), ("x } y", {}),
    ("{}", {"a": 1}), ("{a:.2f}", {"a": "x"}), ("{a:d}", {"a": "x"}), ("{a:.2f}", {"a": None}),
    ("{a:,}", {"a": 1234567.5}), ("{a:,}", {"a": -1234.25}), ("x {", {}), ("{a:>8.2f}|", {"a": 3.14159}),
    ("{a:<8,}|", {"a": 1234}),
]


def run_pf(fmt, args):
    try:
        return {"out": fmt % args}
    except Exception as e:  # noqa: BLE001
        return {"err": [type(e).__name__, str(e)]}


def run_sf(tpl, kw):
    try:
        return {"out": tpl.format(**kw)}
    except Exception as e:  # noqa: BLE001
        return {"err": [type(e).__name__, str(e)]}


def main():
    assert sys.version_info[:2] == (3, 11), sys.version
    cases = []
    for fmt, args in PF:
        cases.append({"kind": "pf", "fmt": fmt, "args": enc(list(args)), **run_pf(fmt, tuple(args))})
    for tpl, kw in SF:
        cases.append({"kind": "sf", "tpl": tpl, "kwargs": enc(kw), **run_sf(tpl, kw)})
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(os.path.dirname(here), "fixtures", "pyfmt_vectors.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"python": sys.version.split()[0], "cases": cases}, fh, ensure_ascii=False, indent=1)
    print(f"wrote {len(cases)} cases → {out}")


if __name__ == "__main__":
    main()
