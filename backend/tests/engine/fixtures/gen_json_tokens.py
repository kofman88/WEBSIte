"""gen_json_tokens.py — json.loads (CPython 3.11, the production interpreter) on texts that stress
services/engine/pyjson.tagJsonTokens: int64 literals in every position, digit runs inside strings
with escapes, the int -0 vs the float -0.0, NaN / Infinity, and malformed texts that must stay errors.

    <prod-like venv, python 3.11>/bin/python -I backend/tests/engine/fixtures/gen_json_tokens.py

Writes json_tokens.json next to this file. Result encoding: ints within 2^53 as JSON ints, larger
ints as {"$big": "<digits>"}, floats as {"$f": repr(x)}, dicts as {"$o": [[k, v], ...]}, errors as
{"$err": "<exception class>"}.
"""
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
rnd = random.Random(20261009)
SAFE = 2 ** 53 - 1


def enc(v):
    if isinstance(v, bool) or v is None or isinstance(v, str):
        return v
    if isinstance(v, int):
        return v if -SAFE <= v <= SAFE else {"$big": str(v)}
    if isinstance(v, float):
        if math.isnan(v):
            return {"$f": "nan"}
        if math.isinf(v):
            return {"$f": "inf" if v > 0 else "-inf"}
        return {"$f": repr(v)}
    if isinstance(v, list):
        return [enc(x) for x in v]
    if isinstance(v, dict):
        return {"$o": [[k, enc(x)] for k, x in v.items()]}
    raise TypeError(type(v))


fixed = [
    '{"orderId": 1735947220470939648}', '{"orderId": -1735947220470939648}', '[9007199254740991, 9007199254740992, 9007199254740993]',
    '[-9007199254740991, -9007199254740992, -9007199254740993]', '{"a": 12345678901234567890123}', '{"a": 1735947220470939648.0}',
    '{"a": 1735947220470939648e0}', '{"a": 1.735947220470939648e18}', '{"s": "1735947220470939648", "n": 1735947220470939648}',
    '{"s": "x\\"1735947220470939648\\"y", "n": 2}', '{"s": "\\\\", "n": 1735947220470939648}', '{"1735947220470939648": 1735947220470939648}',
    '{1735947220470939648: 1}', '[01735947220470939648]', '[0, 1735947220470939648]', '[1735947220470939648 1]', '[-1735947220470939648x]',
    '{"a": 1735947220470939648', '"unterminated 1735947220470939648', '{"data": {"order": {"orderId": 1735947220470939648, "price": "0.1"}}}',
    '{"x": -0}', '{"x": -0.0}', '{"x": -0e0}', '{"x": -0E+1}', '[-0, 0, -0.0, 0.0]', '{"-0": -0}', '{"x": --0}', '{"x": -05}', '{"x": "-0"}',
    '{"a": NaN, "b": Infinity, "c": -Infinity}', '{"a": -NaN}', '{"a": 1NaN}', '{NaN: 1}', '[NaN, "NaN", "Infinity", -Infinity]',
    '{"a": Infinityx}', '{"a": nan}', '[1e400, -1e400, 1e-400]', '[]', '{}', '""', '1735947220470939648', '-0', 'NaN', ' \t\n[1735947220470939648]\r\n',
    '{"code": 0, "data": {"orders": [{"orderId": 1735947220470952953}, {"orderId": 1735947220470982290}]}}',
]
cases = list(fixed)
for _ in range(400):
    parts = []
    for _ in range(rnd.randint(1, 6)):
        kind = rnd.randrange(7)
        if kind == 0:
            parts.append(str(rnd.randint(-(10 ** 22), 10 ** 22)))
        elif kind == 1:
            parts.append(str(rnd.choice([1, -1]) * rnd.randint(2 ** 53 - 5, 2 ** 53 + 5)))
        elif kind == 2:
            parts.append(repr(rnd.uniform(-1e6, 1e6)))
        elif kind == 3:
            parts.append(json.dumps("".join(rnd.choice('0123456789"\\ab-') for _ in range(rnd.randint(0, 24)))))
        elif kind == 4:
            parts.append(rnd.choice(["-0", "-0.0", "0", "NaN", "Infinity", "-Infinity", "true", "null"]))
        elif kind == 5:
            parts.append('{"k%d": %d}' % (rnd.randint(0, 9), rnd.randint(-(10 ** 20), 10 ** 20)))
        else:
            parts.append(str(rnd.randint(0, 10 ** 19)) + rnd.choice(["", "", "x", ".", "e", "e5", ".5"]))
    text = "[" + ", ".join(parts) + "]"
    if rnd.random() < 0.1:
        text = text.replace(",", "", 1)
    cases.append(text)

out = []
for t in cases:
    try:
        out.append({"text": t, "result": enc(json.loads(t))})
    except Exception as e:  # json.JSONDecodeError (a ValueError)
        out.append({"text": t, "result": {"$err": type(e).__name__}})
with open(os.path.join(HERE, "json_tokens.json"), "w", encoding="utf-8") as f:
    json.dump({"python": sys.version.split()[0], "cases": out}, f, ensure_ascii=True, indent=0)
print("wrote", len(out), "cases")
