#!/usr/bin/env python3
"""gen_pysum.py — CPython 3.12 builtin sum() over floats (Neumaier compensated since 3.12)
on random lists shaped like LEVELS pivot groups + edge cases → pysum_expected.json.

    <pinned venv>/bin/python backend/tests/common/fixtures/gen_pysum.py
"""
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
rnd = random.Random(20261008)


def enc(x):
    if isinstance(x, float):
        if math.isnan(x):
            return "nan"
        if math.isinf(x):
            return "inf" if x > 0 else "-inf"
        if x == 0 and math.copysign(1, x) < 0:
            return "-0.0"
    return repr(x)


cases = []
for mag in (0.00012, 0.0366, 1.2345, 97.5, 3200.0, 56442.97, 1e-7, 1e9):
    for _ in range(40):
        n = rnd.randint(1, 9)
        lst = [mag * (1 + rnd.uniform(-0.004, 0.004)) for _ in range(n)]
        cases.append(lst)
for _ in range(60):   # mixed magnitudes (the |f_result| < |x| branch)
    n = rnd.randint(2, 8)
    cases.append([rnd.choice([1e-9, 1.0, 1e3, 1e8, 1e16, -1e16, 3.0, 1e-300]) * (1 + rnd.uniform(-0.5, 0.5)) for _ in range(n)])
special = [
    [], [0.1], [0.1, 0.2], [0.1, 0.2, 0.3], [1e16, 1.0, -1e16], [1.0, 1e16, -1e16], [1e308, 1e308], [1e308, 1e308, -1e308],
    [float("inf"), 1.0], [float("inf"), float("-inf")], [float("nan"), 1.0], [1.0, float("nan")], [-0.0], [-0.0, -0.0], [0.0, -0.0],
    [1e-16, 1.0, -1.0], [1.0, 1e-16, -1.0], [56442.97, 56442.98, 56442.96], [0.0366413355, 0.0366413356],
]
cases += special
out = []
n_diff = 0
for lst in cases:
    s = sum(lst)
    seq = 0.0
    for v in lst:
        seq += v
    if enc(s) != enc(seq):
        n_diff += 1
    out.append(dict(values=[enc(v) for v in lst], sum=enc(s)))
with open(os.path.join(HERE, "pysum_expected.json"), "w", encoding="utf-8") as f:
    json.dump(dict(python=sys.version.split()[0], note="builtin sum(list_of_floats); values/sum encoded with repr", cases=out), f)
print("wrote", len(out), "cases;", n_diff, "differ from a sequential sum")
