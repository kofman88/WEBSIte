"""gen_unicode_tables.py — the Unicode data backend/strategies/common/pyUnicode.js embeds so that
the ports of int() / float() / repr() / re `\\d` `\\s` `\\w` `\\b` / str.isspace() / isdigit() /
isupper() / lower() / upper() / capitalize() behave as in the bot's CPython (3.11, the production
interpreter: unicodedata 14.0.0) instead of following the Unicode version the Node runtime ships
(Node 22: Unicode 16). Used through strategies/common/pyUnicode.js by challengeService.js,
entryAdvisor.js, exchanges/pyCompat.js, marketData/candleFrame.js, strategies/common/pynum.js
(every int()/float() of a str) and the str.strip() / case-mapping / regex ports.

Run with the production interpreter; it rewrites the block between the `BEGIN/END unicode
tables` markers of backend/strategies/common/pyUnicode.js (without --write it prints it):
  <python3.11 venv>/bin/python gen_unicode_tables.py --write

  ND_ZEROS        code points of the digit zero of every Nd run (each run is zero … zero + 9)
  PY_SPACE_HI     non-ASCII characters of str.isspace() (int()/float() read them as ' ')
  NONPRINT        not str.isprintable() above 0x7f                      (repr())
  DIGIT           str.isdigit() of one character                       (isdigit())
  ALNUM           str.isalnum() of one character                       (re \\w = ALNUM + '_')
  UPPER / LOWER / TITLE   Py_UNICODE_ISUPPER / ISLOWER / ISTITLE        (isupper(), cased)
  CASE_IGNORABLE  _PyUnicode_IsCaseIgnorable (the Final_Sigma context of lower())
  UNASSIGNED      category Cn: no case mapping in 3.11 (Node maps some of them)
  TITLE_SPECIAL   chars whose str.title() (capitalize()'s first letter) differs from upper()
  RE_IGNORECASE_EXTRA  what an ASCII letter of a re.IGNORECASE pattern matches beyond its own
                  two cases (i: İ ı, k: K, s: ſ) — strategies/common/pyre.js
Range tables are delta-encoded in base 36: "<start - previous end>.<length - 1>" joined by ",".
"""
import os
import re
import sys
import unicodedata

assert sys.version_info[:2] == (3, 11), sys.version   # the production interpreter
N = 0x110000
zeros = [c for c in range(N) if unicodedata.category(chr(c)) == "Nd" and unicodedata.decimal(chr(c)) == 0]
for z in zeros:                                    # every run is aligned: zero … zero + 9
    assert all(unicodedata.decimal(chr(z + k), -1) == k for k in range(10)), hex(z)
assert not [c for c in range(N) if unicodedata.decimal(chr(c), None) is not None
            and unicodedata.category(chr(c)) != "Nd"]
spaces = [c for c in range(0x80, N) if chr(c).isspace()]


def ranges_of(pred, lo=0):
    out, start = [], None
    for c in range(lo, N + 1):
        on = c < N and pred(c)
        if on and start is None:
            start = c
        elif not on and start is not None:
            out.append((start, c - 1))
            start = None
    return out


def b36(n):
    s = ""
    while True:
        n, r = divmod(n, 36)
        s = "0123456789abcdefghijklmnopqrstuvwxyz"[r] + s
        if n == 0:
            return s


def enc(ranges):
    prev, parts = 0, []
    for a, b in ranges:
        parts.append(f"{b36(a - prev)}.{b36(b - a)}")
        prev = b
    return ",".join(parts)


def upper_flag(c):
    return chr(c).isupper()


def lower_flag(c):
    return chr(c).islower()


def title_flag(c):
    return chr(c).istitle() and not chr(c).isupper()


def cased(c):
    return upper_flag(c) or lower_flag(c) or title_flag(c)


def case_ignorable(c):
    """Read _PyUnicode_IsCaseIgnorable back from lower()'s Final_Sigma rule (handle_capital_sigma)."""
    x = chr(c)
    if cased(c):                      # '1' x 'Σ': σ ⇔ x is skipped (ignorable) and '1' is not cased
        return ("1" + x + "Σ").lower()[-1] == "σ"
    return ("AΣ" + x + "B").lower()[1] == "σ"   # σ ⇔ x skipped and 'B' cased


# the Final_Sigma reading must agree with the definition Cased = Lowercase ∪ Uppercase ∪ Lt
for c in (0x41, 0x61, 0x1c5, 0x2b0, 0x345, 0x10d0):
    assert ("1" + chr(c) + "Σ").lower()[-1] in "ςσ"

title_special = {}
for c in range(N):
    t, u = chr(c).title(), chr(c).upper()
    if t != u:
        title_special[c] = t
ignorecase_extra = {}                              # re.IGNORECASE: what an ASCII letter matches beyond its pair
for L in "abcdefghijklmnopqrstuvwxyz":
    m = [c for c in range(N) if re.fullmatch(L, chr(c), re.IGNORECASE) and chr(c) not in (L, L.upper())]
    if m:
        ignorecase_extra[ord(L)] = m
W = re.compile(r"\w")
alnum = ranges_of(lambda c: chr(c).isalnum())
assert ranges_of(lambda c: W.fullmatch(chr(c)) is not None) == ranges_of(lambda c: chr(c).isalnum() or c == 0x5f)

lines = [
    f"// unicodedata {unicodedata.unidata_version} (CPython {sys.version.split()[0]})",
    "const ND_ZEROS = [" + ", ".join(hex(z) for z in zeros) + "];",
    "const PY_SPACE_HI = [" + ", ".join(hex(c) for c in spaces) + "];",
    "const NONPRINT = '" + enc(ranges_of(lambda c: not chr(c).isprintable(), 0x80)) + "';",
    "const DIGIT = '" + enc(ranges_of(lambda c: chr(c).isdigit())) + "';",
    "const ALNUM = '" + enc(alnum) + "';",
    "const UPPER = '" + enc(ranges_of(upper_flag)) + "';",
    "const LOWER = '" + enc(ranges_of(lower_flag)) + "';",
    "const TITLE = '" + enc(ranges_of(title_flag)) + "';",
    "const CASE_IGNORABLE = '" + enc(ranges_of(case_ignorable)) + "';",
    "const UNASSIGNED = '" + enc(ranges_of(lambda c: unicodedata.category(chr(c)) == "Cn")) + "';",
    "const TITLE_SPECIAL = {" + ", ".join("0x%x: '%s'" % (c, "".join("\\u{%x}" % ord(ch) for ch in t))
                                          for c, t in sorted(title_special.items())) + "};",
    "const RE_IGNORECASE_EXTRA = {" + ", ".join("0x%x: [%s]" % (c, ", ".join(hex(x) for x in m))
                                                for c, m in sorted(ignorecase_extra.items())) + "};",
]
block = "\n".join(lines)
if "--write" in sys.argv:
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "strategies", "common", "pyUnicode.js")
    src = open(path, encoding="utf-8").read()
    head, rest = src.split("// BEGIN unicode tables\n", 1)
    _, tail = rest.split("// END unicode tables\n", 1)
    open(path, "w", encoding="utf-8").write(head + "// BEGIN unicode tables\n" + block + "\n// END unicode tables\n" + tail)
    print("wrote", os.path.normpath(path))
else:
    print(block)
