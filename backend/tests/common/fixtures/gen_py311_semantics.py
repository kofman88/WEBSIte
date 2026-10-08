#!/usr/bin/env python3
"""gen_py311_semantics.py — the interpreter-dependent str / number / re / json / datetime semantics
the JS port re-implements, printed by the production interpreter (CPython 3.11, unicodedata 14.0.0)
→ py311_semantics.json.gz, replayed by tests/common/py311Semantics.test.js.

    cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \\
      <python3.11 venv>/bin/python /path/to/backend/tests/common/fixtures/gen_py311_semantics.py; \\
      rm -f signal_registry.json

Sections (every value printed by the interpreter or the bot's own functions):
  unicode     per code point: isspace / isdecimal / isdigit / isalnum / isprintable / isupper /
              islower / istitle, re \\w \\d \\s, the Final_Sigma reading of lower(), category Cn,
              and every non-identity lower() / upper() / capitalize() of one character
  strings     random strings (ASCII, Unicode 14 / 15 / 16 additions, Σ contexts, ligatures) →
              lower / upper / capitalize / isupper / isdigit / isspace / strip / lstrip / rstrip / repr
  numbers     int(str) / float(str): Unicode digits (incl. the Unicode 15 Kawi / Nag Mundari ones
              3.12 accepts), str.isspace() padding, PEP 515 underscores, inf / nan, the 4300-digit limit
  days        kb_disabled_days: {int(d) for d in raw.split(",") if d.strip().isdigit()}
  regex       re.search of the bot's patterns (and \\b \\w \\d \\s \\D \\S \\W . $ IGNORECASE) on
              random text; bybit / bingx / binance _humanize_*_error of the bot
  volume_cfg  volume_strategy.VolumeConfig.from_params on str values (strip / lower / int / float)
  smc_keys    smc.analyzer.SMCConfig(**{key: 99}) — which keys are taken (key.isupper())
  normalize_strategy   db.stats.normalize_strategy (str(value).strip().upper())
  json        json.loads (NaN / Infinity, -0, invalid)
  timestamps  datetime.fromtimestamp(ts, tz=utc): date / hour / weekday (half-even microseconds)
  encodings   encodings.normalize_encoding(name.lower())
  clamps      builtin max(a, b) / min(a, b) with NaN / ±0 / inf; user_manager.TradeCfg.__post_init__ and
              scanner_mid._cfg_to_ind MIN_RR; signal_tracker / db.signal_outcome env constants (module
              reloaded per env); cache_warmer.CacheWarmer rate / interval; genome._GENOME_CPU_SHARE
"""
import datetime
import encodings
import gzip
import json
import os
import random
import re
import sys
import unicodedata

assert sys.version_info[:2] == (3, 11), sys.version   # the production interpreter
BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
sys.path.insert(0, BOT)
os.chdir(BOT)
import bybit_trader  # noqa: E402
import bingx_trader  # noqa: E402
import binance_trader  # noqa: E402
import volume_strategy  # noqa: E402
from smc.analyzer import SMCConfig  # noqa: E402
from db.stats import normalize_strategy  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "py311_semantics.json.gz")
R = random.Random(20261008)
N = 0x110000


def run(fn, *a):
    try:
        v = fn(*a)
    except Exception as e:  # noqa: BLE001
        return {"exc": type(e).__name__, "msg": str(e)}
    return enc(v)


def enc(v):
    if isinstance(v, float):
        return {"f": repr(v)}
    if isinstance(v, int) and not isinstance(v, bool) and abs(v) >= 2 ** 53:
        return {"int": str(v)}
    if isinstance(v, (list, tuple)):
        return [enc(x) for x in v]
    if isinstance(v, dict):
        return {k: enc(x) for k, x in v.items()}
    return v


# ── unicode: per code point ─────────────────────────────────────────────────
def ranges_of(pred):
    out, start = [], None
    for c in range(N + 1):
        on = c < N and pred(c)
        if on and start is None:
            start = c
        elif not on and start is not None:
            out.append([start, c - 1])
            start = None
    return out


def cased(c):
    ch = chr(c)
    return ch.isupper() or ch.islower() or (ch.istitle() and not ch.isupper())


def case_ignorable(c):
    x = chr(c)
    if cased(c):
        return ("1" + x + "\u03a3").lower()[-1] == "\u03c3"
    return ("A\u03a3" + x + "B").lower()[1] == "\u03c3"


W, D, S = re.compile(r"\w"), re.compile(r"\d"), re.compile(r"\s")
unicode_props = {
    "isspace": ranges_of(lambda c: chr(c).isspace()),
    "isdecimal": ranges_of(lambda c: chr(c).isdecimal()),
    "isdigit": ranges_of(lambda c: chr(c).isdigit()),
    "isalnum": ranges_of(lambda c: chr(c).isalnum()),
    "isprintable": ranges_of(lambda c: chr(c).isprintable()),
    "isupper": ranges_of(lambda c: chr(c).isupper()),
    "islower": ranges_of(lambda c: chr(c).islower()),
    "istitle_only": ranges_of(lambda c: chr(c).istitle() and not chr(c).isupper()),
    "re_w": ranges_of(lambda c: W.fullmatch(chr(c)) is not None),
    "re_d": ranges_of(lambda c: D.fullmatch(chr(c)) is not None),
    "re_s": ranges_of(lambda c: S.fullmatch(chr(c)) is not None),
    "case_ignorable": ranges_of(case_ignorable),
    "unassigned": ranges_of(lambda c: unicodedata.category(chr(c)) == "Cn"),
}
case_maps = {"lower": {}, "upper": {}, "capitalize": {}}
for c in range(N):
    if 0xD800 <= c <= 0xDFFF:
        continue
    ch = chr(c)
    for k in case_maps:
        v = getattr(ch, k)()
        if v != ch:
            case_maps[k][str(c)] = v
ignorecase = {L: [c for c in range(N) if re.fullmatch(L, chr(c), re.IGNORECASE)] for L in "abcdefghijklmnopqrstuvwxyz"}

# ── random text ─────────────────────────────────────────────────────────────
NEW15 = ["\U00011f50", "\U00011f59", "\U0001e4f0", "\U0001e4f9", "\U0001e030", "\U00031350", "\U0001fae8", "\U0001f6dc", "\U0001d2c0", "\U00011f04"]
NEW16 = ["\u1c89", "\u1c8a", "\ua7cb", "\ua7cc", "\ua7cd", "\ua7da", "\ua7db", "\ua7dc", "\U00010d50", "\U00010d70", "\U000105c0", "\U00016d40"]
GAIN16 = ["\u0264", "\u019b"]                   # assigned long ago; gained an uppercase in Unicode 16
DIGITS = ["0", "7", "\u0661", "\u06f5", "\u0967", "\u0e53", "\uff13", "\U0001d7ce", "\U00016a61", "\U0001e950", "\U00011f53", "\U0001e4f4", "\u00b2", "\u2463"]
SPACES = [" ", "\t", "\n", "\r", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x1f", "\x85", "\xa0", "\u1680", "\u2000", "\u2007", "\u200a",
          "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff", "\u180e", "\u200b", "\u2060"]
LETTERS = list("abcxyzABCXYZ_") + ["\u0436", "\u0416", "\u0451", "\u00e9", "\u00df", "\u0130", "\u0131", "\u017f", "\u212a", "\u01c5", "\u01c6",
                                  "\u03a3", "\u03c3", "\u03c2", "\ufb01", "\u1fb3", "\u0345", "\u0301", "\u02b0", "\u00aa", "\u2160", "\u24b6", "\u10d0",
                                  "\u1c90", "\u13a0", "\uab70", "\u0c5d", "\u0c3c", "\U0001e900", "\U0001e922", "\u1e9e", "\u0149", "\u0390"]
PUNCT = list(".,:;!?'\"\\-()[]{}/") + ["\x00", "\x7f", "\xad", "\u0378", "\ue000", "\U000e0001", "\U0001f600"]
POOL = DIGITS + SPACES + LETTERS + PUNCT + NEW15 + NEW16 + GAIN16


def rtext(n=None):
    n = R.randint(0, 14) if n is None else n
    return "".join(R.choice(POOL) for _ in range(n))


texts = [rtext() for _ in range(5000)] + ["", "\u03a3", "A\u03a3", "A\u03a3B", "A\u03a3\u02b0", "A\u03a3\u02b0B", "A\u03a3\U00010d50",
                                          "\U00010d50\u03a3", "\ua7cb\u03a3", "1\u02b0\u03a3", "\u01c6emal", "\u00dfa", "\ufb01x", "\u1fb3bc", "\u0130stanbul",
                                          "\u0149", "\u0264\u019b", "\u03a3\u0301", "AB\u03a3 C", "\u00c0", "\u00c01", "_A", "A_B", "1"]
strings = [[s, s.lower(), s.upper(), s.capitalize(), s.isupper(), s.isdigit(), s.isspace(), s.strip(), s.lstrip(), s.rstrip(), repr(s)]
           for s in texts]

# ── numbers ─────────────────────────────────────────────────────────────────
def rnum():
    parts = []
    if R.random() < 0.3:
        parts.append("".join(R.choice(SPACES) for _ in range(R.randint(1, 2))))
    if R.random() < 0.3:
        parts.append(R.choice("+-"))
    if R.random() < 0.07:
        parts.append(R.choice(["inf", "Inf", "INFINITY", "iNfInItY", "nan", "NaN", "infin", "in_f", "nan_"]))
    else:
        body = ""
        for _ in range(R.randint(0, 6)):
            body += R.choice(DIGITS[:12]) if R.random() < 0.5 else R.choice("0123456789")
            if R.random() < 0.12:
                body += "_" * R.choice([1, 1, 2])
        if R.random() < 0.35:
            body += R.choice([".", ".", "\u066b", ","]) + "".join(R.choice("0123456789\u0663") for _ in range(R.randint(0, 3)))
        if R.random() < 0.15:
            body += R.choice("eE") + R.choice(["", "+", "-"]) + "".join(R.choice("0123\u0662") for _ in range(R.randint(0, 3)))
        parts.append(body)
    if R.random() < 0.06:
        parts.insert(R.randint(0, len(parts)), R.choice(POOL))
    if R.random() < 0.3:
        parts.append("".join(R.choice(SPACES) for _ in range(R.randint(1, 2))))
    return "".join(parts)


nums = [rnum() for _ in range(4000)] + ["", " ", "1", "-0", "+0", "007", "1_000", "1__0", "_1", "1_", "1_000.5", "1e1_0", ".5", "5.", ".",
                                        "1e", "\x1c12", "12\x85", "\ufeff12", "\u3000\u0661\u0662\u3000", "\U00011f51", "1\U0001e4f0",
                                        "\U0001d7ce\U0001d7cf", "\u00b2", "1" * 4300, "1" * 4301, "9" * 400 + ".5", "1e400", "-1e400", "2e-324",
                                        "+inf", "-nan", "0x10", "1j", "\u0661\u066b\u0665"]
numbers = [[s, run(int, s), run(float, s)] for s in nums]

# ── kb_disabled_days ────────────────────────────────────────────────────────
days = []
for _ in range(2500):
    raw = ",".join(R.choice([rnum(), R.choice("0123456"), R.choice(DIGITS), R.choice(DIGITS) + R.choice(SPACES), R.choice(SPACES) + "3",
                             "1", "1", ""]) for _ in range(R.randint(0, 5)))
    days.append([raw, run(lambda r: sorted({int(d) for d in r.split(",") if d.strip().isdigit()}), raw)])

# ── re: the bot's patterns + the Unicode-dependent constructs ───────────────
PATTERNS = [
    (r"\b(ErrCode|retCode|status_code)[:\s]+(\d+)", re.IGNORECASE),
    (r"\((\d{3,6})\)", 0),
    (r"\s*\(ErrCode:\s*\d+\)\s*|\s*\(ErrTime:\s*[\d:]+\)\s*", re.IGNORECASE),
    (r"maxLeverage\s*\[(\d+)\]", re.IGNORECASE),
    (r'"code"\s*:\s*(-?\d+)', 0),
    (r"\b(\d{5,6})\b", 0),
    (r'"msg"\s*:\s*"([^"]+)"', 0),
    (r"[-+]?\d+(?:[.,]\d+)?", 0),
    (r"\b\w+\b", 0), (r"\W+", 0), (r"\D\S", 0), (r"a.b", 0), (r"x$", 0), (r"[\w-]+", 0), (r"kis", re.IGNORECASE),
]
FRAGS = ["ErrCode", "errcode", "ERRCODE", "retCode", "status_code", "\u017ftatus_code", "Status_Code", "maxLeverage", "MAXLEVERAGE",
         "ma\u0131xleverage", "(ErrCode: ", "(ErrTime: ", ")", "(", "[", "]", ":", '"code"', '"msg"', ' : ', '"', "-", "kis", "K\u0130S",
         "\u212ais", "a", "b", "x", "\n", "12345", "101204", "\u0661\u0660\u0661\u0662\u0660\u0664", "\U00011f51\U00011f52\U00011f53"]


def rre_text():
    out = []
    for _ in range(R.randint(1, 8)):
        k = R.random()
        if k < 0.45:
            out.append(R.choice(FRAGS))
        elif k < 0.7:
            out.append("".join(R.choice(DIGITS[:12]) for _ in range(R.randint(1, 7))))
        else:
            out.append(rtext(R.randint(1, 3)))
    return "".join(out)


regex = []
for pi, (pat, flags) in enumerate(PATTERNS):
    cre = re.compile(pat, flags)
    for _ in range(220):
        s = rre_text()
        m = cre.search(s)
        regex.append([pi, s, None if m is None else [m.start(), m.end(), list(m.groups())], cre.sub("<>", s)])
humanize = []
for _ in range(2500):
    s = rre_text()
    if R.random() < 0.3:
        s += R.choice([" not live", " Contract is not", " auth failed", " retryable", " RETRYABLE auth", "."])
    humanize.append([s, run(bybit_trader._humanize_bybit_error, s), run(bingx_trader._humanize_bingx_error, s),
                     run(binance_trader._humanize_binance_error, s)])

# ── VolumeConfig.from_params / SMCConfig keys ───────────────────────────────
BOOL_WORDS = ["1", "true", "TRUE", "yes", "On", "0", "false", "no", "", " true ", "\x1ctrue", "\ufefftrue", "true\x85", "\u0130", "tru\u0435"]
volume_cfg = []
for _ in range(1500):
    p = {
        "setup_cross": R.choice(BOOL_WORDS + [rtext(3)]),
        "use_htf": R.choice(BOOL_WORDS),
        "ma_type": R.choice(["EMA", " ema ", "\x1cema", "\ufeffema", "SMA\x85", "\u0130", "ema\u200b", "e\u217fa", rtext(3)]),
        "vol_len": R.choice([rnum(), "20", "2_0", "\u0662\u0660", " 30 "]),
        "vol_mult": R.choice([rnum(), "1.5", "1_5.0", "\uff12", "inf", "nan"]),
    }
    cfg = volume_strategy.VolumeConfig.from_params(p)
    volume_cfg.append([p, enc({k: getattr(cfg, k) for k in p})])
smc_keys = []
for _ in range(1500):
    key = R.choice(["MIN_RR", "VOL_LEN", "min_rr", "_MIN_RR", "Min_RR", "A1", "1", "", "\u00c0", "\u00c01", "A\u00df", "A\u01c5", "\u2160",
                    "A\u0264", "A\U00010d70", "\U00010d50", "A\ua7cb", "\u03a3\u03c3"] + [rtext(R.randint(1, 4))])
    cfg = SMCConfig(**{key: 99})
    smc_keys.append([key, key in vars(cfg) and getattr(cfg, key) == 99])

STRATS = ["LEVELS", "smc", "Volume", " levels ", "\x1cSMC", "SMC\x85", "﻿VOLUME", "　levels", "gerchik", "герчик",
          "scalping ", "ɤ", "smc​", "LEGACY", "", "x"]
normalize = [[v, normalize_strategy(v)] for v in STRATS + [R.choice(STRATS) + rtext(R.randint(0, 2)) for _ in range(500)]]

# ── json.loads ──────────────────────────────────────────────────────────────
JSON_TEXTS = ['{"a": NaN}', '{"a": Infinity, "b": -Infinity}', '[1, 2.0, -0, -0.0, 1e400, 1E5, -0e0]', '{"a": 1, "a": 2}', '{"x": -0}',
              ' {"x": "\\u00e9\\ud83d\\ude00"} ', '[]', '', 'NaN', '-NaN', '{"a": nan}', '[1,]', '{"a":1}x', '"\\ud800"', '[\u00a01]',
              '[\u0661]', '01', '-', '1.', '.5', '[true, false, null]', 'tru', '{"a": [1, {"b": -0}]}', '1 2', '{NaN: 1}', '[-Infinity]']
json_cases = [[t, run(json.loads, t)] for t in JSON_TEXTS]

# ── datetime.fromtimestamp(ts, tz=utc) ──────────────────────────────────────
timestamps = []
for ts in (1704067199.9999996, 1704067199.9999994, 1704067199.5, 1700000059.9999995):   # pinned by the site tests
    d = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc)
    timestamps.append([repr(ts), d.strftime("%Y-%m-%d"), d.hour, d.weekday()])
for i in range(3000):
    base = R.randint(0, 4102444800)
    if i % 3 == 0:
        base = (base // 86400) * 86400 - 1          # one second before a UTC midnight
    ts = base + R.choice([0.0, 0.5, 0.9999995, 0.9999994999, 0.99999949, 0.9999996, 0.4999995, 1e-7, R.random()])
    d = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc)
    timestamps.append([repr(ts), d.strftime("%Y-%m-%d"), d.hour, d.weekday()])

# ── encodings.normalize_encoding ────────────────────────────────────────────
ENC_POOL = list("utf8-_ .UTFLATIN1asci") + ["\u00e9", "\u0661", "\uff18", "\u2160", "\u00df", " -;#", "\u0130"]
enc_names = ["utf-8", "UTF-8", "utf8", "utf_8_sig", "latin-1", "ISO-8859-1", " -utf--8- ", "utf\u00e98", "utf-\uff18", "us-ascii"] + [
    "".join(R.choice(ENC_POOL) for _ in range(R.randint(1, 10))) for _ in range(800)]
encodings_cases = [[n, encodings.normalize_encoding(n.lower())] for n in enc_names]

# ── builtin max(a, b) / min(a, b) clamps (the first argument wins: a NaN 2nd one is ignored) ──
import importlib  # noqa: E402
import cache_warmer  # noqa: E402
import genome  # noqa: E402
import scanner_mid  # noqa: E402
import signal_tracker  # noqa: E402
import user_manager  # noqa: E402
from config import Config  # noqa: E402
from db import signal_outcome  # noqa: E402

NAN, INF = float("nan"), float("inf")
CLAMP_POOL = [NAN, INF, -INF, 0.0, -0.0, 0, 1, -1, 0.05, 0.1, 0.3, 0.5, 1.0, 1.8, 2.0, 5.0, 5.000000000000001, 10, 10.0,
              10.5, 11, -5, 15.0, 60, 86400, 86401.5, 1e308, 5e-324, -5e-324]


def rclamp():
    r = R.random()
    if r < 0.6:
        return R.choice(CLAMP_POOL)
    if r < 0.8:
        return R.uniform(-20, 20)
    return R.randint(-20, 20)


maxmin = []
for i in range(3000):
    a, b = rclamp(), rclamp()
    if i >= 2500:      # one side NaN or a zero of either sign: where builtin max/min and Math.max/min part
        a, b = (a, R.choice([NAN, 0.0, -0.0, 0])) if R.random() < 0.5 else (R.choice([NAN, 0.0, -0.0, 0]), b)
    maxmin.append([enc(a), enc(b), enc(max(a, b)), enc(min(a, b))])

TC_FIELDS = ["min_rr", "max_risk_pct", "cooldown_bars", "tp1_rr", "tp2_rr", "tp3_rr", "scan_interval", "min_quality", "vol_mult"]
LEVELS_MIN_RR0 = Config.LEVELS_MIN_RR
trade_cfg = []
for _ in range(2000):
    kw = {k: rclamp() for k in R.sample(TC_FIELDS, R.randint(1, len(TC_FIELDS)))}
    cfg = user_manager.TradeCfg(**kw)
    Config.LEVELS_MIN_RR = R.choice([1.8, NAN, INF, -INF, 0.5, 3.0])
    ind = scanner_mid._cfg_to_ind(cfg)
    trade_cfg.append([enc(kw), enc(Config.LEVELS_MIN_RR), enc({k: getattr(cfg, k) for k in TC_FIELDS}), enc(ind.MIN_RR)])
Config.LEVELS_MIN_RR = LEVELS_MIN_RR0

ENV_TEXTS = ["", "nan", "NaN", "-nan", "inf", "-inf", "Infinity", "1e400", "-1e400", "1_0", "1__0", " 30 ", "\x1c20\x85",
             "٣٠", "１５", "abc", "0", "-0", "-5", "1e3", "16", "7.5", "0x10", "0.29", "100.9", "5e-324",
             "  2 　", "1_000_0", "\U00011f52", "\U0001e4f3"]
ENABLED_TEXTS = ["1", "0", "false", " off ", "", "FALSE", "\x1c0", " off", "0\x85", "off​", "no", "﻿0"]
ST_ENV = ["SIGNAL_TRACKER_INTERVAL_S", "SIGNAL_TRACKER_MAX_AGE_H", "SIGNAL_TRACKER_SEND_DELAY_S", "SIGNAL_TRACKER_REST_PER_CYCLE",
          "SIGNAL_TRACKER_MAX_ROWS", "SIGNAL_TRACKER_MAX_EVENT_LAG_H", "SIGNAL_MISSED_R", "SIGNAL_MISSED_MIN_AGE_S", "SIGNAL_TRACKER_ENABLED"]
ST_CONST = ["ENABLED", "INTERVAL_S", "MAX_AGE_H", "SEND_DELAY_S", "REST_PER_CYCLE", "MAX_ROWS", "MAX_EVENT_LAG_H", "MISSED_R",
            "MISSED_MIN_AGE_S"]
ENV_KEYS = ST_ENV + ["GENOME_CPU_SHARE", "CACHE_WARMER_RATE", "CACHE_WARMER_INTERVAL"]
ENV0 = {k: os.environ.get(k) for k in ENV_KEYS}


def set_env(env):
    for k in ENV_KEYS:
        os.environ.pop(k, None)
    os.environ.update(env)


def reload_tracker(env):
    set_env(env)
    try:
        importlib.reload(signal_tracker)
    except Exception as e:  # noqa: BLE001 — the bot does not start with this env
        return {"exc": type(e).__name__, "msg": str(e)}
    return {k: getattr(signal_tracker, k) for k in ST_CONST}


tracker_env = []
for _ in range(400):
    env = {k: R.choice(ENABLED_TEXTS if k == "SIGNAL_TRACKER_ENABLED" else ENV_TEXTS) for k in ST_ENV if R.random() < 0.4}
    got = reload_tracker(env)
    crash = []
    if "exc" in got:      # which variables crash the import on their own; the rest of the constants without them
        crash = sorted(k for k in env if "exc" in reload_tracker({k: env[k]}))
        got = reload_tracker({k: v for k, v in env.items() if k not in crash})
    set_env(env)
    tracker_env.append([env, crash, enc(got), enc(run(signal_outcome._env_hours, "SIGNAL_TRACKER_MAX_AGE_H", 72.0))])

warmer = []
for _ in range(600):
    r, c = rclamp(), rclamp()
    w = cache_warmer.CacheWarmer(None, None, rate_per_sec=r, cycle_interval_s=c)
    warmer.append([enc(r), enc(c), enc([w._rate, w._cycle_interval])])
def warmer_from_env(env):
    set_env(env)
    try:
        w = cache_warmer.CacheWarmer.from_env(None, None)
    except Exception as e:  # noqa: BLE001 — the warmer task dies with this env
        return {"exc": type(e).__name__, "msg": str(e)}
    return [w._rate, w._cycle_interval]


warmer_env = []
for _ in range(300):
    env = {k: R.choice(ENV_TEXTS) for k in ("CACHE_WARMER_RATE", "CACHE_WARMER_INTERVAL") if R.random() < 0.7}
    got = warmer_from_env(env)
    crash = []
    if isinstance(got, dict):
        crash = sorted(k for k in env if isinstance(warmer_from_env({k: env[k]}), dict))
        got = warmer_from_env({k: v for k, v in env.items() if k not in crash})
    warmer_env.append([env, crash, enc(got)])

N_CPU = len(os.sched_getaffinity(0))
cpu_share = []
for t in ENV_TEXTS + ["0.5", "2", "0.01", "0.049", "1.0000001", "٠.٢", "1e-400", " 0.3\x1f"]:
    set_env({"GENOME_CPU_SHARE": t})
    try:
        importlib.reload(genome)
        cpu_share.append([t, enc(genome._GENOME_CPU_SHARE)])
    except Exception as e:  # noqa: BLE001 — the bot does not start with this env
        cpu_share.append([t, {"exc": type(e).__name__, "msg": str(e)}])
set_env({k: v for k, v in ENV0.items() if v is not None})
importlib.reload(signal_tracker)
importlib.reload(genome)
clamps = {"maxmin": maxmin, "trade_cfg": trade_cfg, "tracker_env": tracker_env, "warmer": warmer, "warmer_env": warmer_env,
          "cpu_share": cpu_share, "n_cpu": N_CPU, "default_cpu_share": genome._default_cpu_share()}

out = {
    "python": sys.version.split()[0], "unidata": unicodedata.unidata_version,
    "unicode": {"props": unicode_props, "maps": case_maps, "ignorecase": ignorecase},
    "strings": strings, "numbers": numbers, "days": days,
    "regex_patterns": [[p, bool(f & re.IGNORECASE)] for p, f in PATTERNS], "regex": regex, "humanize": humanize,
    "volume_cfg": volume_cfg, "smc_keys": smc_keys, "normalize_strategy": normalize, "json": json_cases, "timestamps": timestamps, "encodings": encodings_cases,
    "clamps": clamps,
}
raw = json.dumps(out, ensure_ascii=True, sort_keys=True).encode("ascii")
with open(OUT, "wb") as fh:
    with gzip.GzipFile(filename="", mode="wb", fileobj=fh, mtime=0) as gz:
        gz.write(raw)
print("wrote", os.path.normpath(OUT), {k: len(v) for k, v in out.items() if isinstance(v, list)})
