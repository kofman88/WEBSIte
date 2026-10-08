"""gen_unicode_tables.py — the Unicode data backend/services/engine/pyUnicode.js embeds so that
int() / float() / repr() / re `\\d` / str.isspace() behave as in the bot's CPython (3.11, the
production interpreter: unicodedata 14.0.0) instead of following whatever Unicode version the
Node runtime ships (Node 22: Unicode 16). Used by challengeService.js, entryAdvisor.js,
exchanges/pyCompat.js (repr), marketData/candleFrame.js (int/float digits) and the
str.strip() ports.

Prints the three tables as JS constants; paste them between the `BEGIN/END unicode tables`
markers of backend/services/engine/pyUnicode.js (run with the production interpreter):
  <python3.11 venv>/bin/python gen_unicode_tables.py

  ND_ZEROS        code points of the digit zero of every Nd run (each run is zero … zero + 9)
  PY_SPACE_HI     non-ASCII characters of str.isspace() (int()/float() read them as ' ')
  NONPRINT        ranges of not str.isprintable() above 0x7f, delta-encoded in base 36
                  ("<start - previous end>.<length - 1>" joined by ","), for repr()
"""
import sys
import unicodedata

assert sys.version_info[:2] == (3, 11), sys.version   # the production interpreter
zeros = [c for c in range(0x110000) if unicodedata.category(chr(c)) == "Nd" and unicodedata.decimal(chr(c)) == 0]
for z in zeros:                                    # every run is aligned: zero … zero + 9
    assert all(unicodedata.decimal(chr(z + k), -1) == k for k in range(10)), hex(z)
assert not [c for c in range(0x110000) if unicodedata.decimal(chr(c), None) is not None
            and unicodedata.category(chr(c)) != "Nd"]
spaces = [c for c in range(0x80, 0x110000) if chr(c).isspace()]
ranges = []
start = None
for c in range(0x80, 0x110001):
    np_ = c < 0x110000 and not chr(c).isprintable()
    if np_ and start is None:
        start = c
    elif not np_ and start is not None:
        ranges.append((start, c - 1))
        start = None


def b36(n):
    s = ""
    while True:
        n, r = divmod(n, 36)
        s = "0123456789abcdefghijklmnopqrstuvwxyz"[r] + s
        if n == 0:
            return s


prev = 0
enc = []
for a, b in ranges:
    enc.append(f"{b36(a - prev)}.{b36(b - a)}")
    prev = b
print(f"// unicodedata {unicodedata.unidata_version} (CPython {sys.version.split()[0]})")
print("const ND_ZEROS = [" + ", ".join(hex(z) for z in zeros) + "];")
print("const PY_SPACE_HI = [" + ", ".join(hex(c) for c in spaces) + "];")
line = ",".join(enc)
print("const NONPRINT = '" + line + "';")
