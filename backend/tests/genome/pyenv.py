"""pyenv.py — shared setup of the genome vector generators (bot repo on sys.path, pinned env).

Run the generators with the production interpreter (CPython 3.11 + the bot's pinned requirements)
from any cwd, e.g.
  VENV=/path/to/venv/bin/python
  $VENV backend/tests/genome/make_genome_vectors.py
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
The bot repo is only read (sys.dont_write_bytecode, temp SQLite files under /tmp).
"""
from __future__ import annotations

import json
import math
import os
import sys

BOT_DIR = os.environ.get("GOLDEN_BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN_DIR = os.path.join(HERE, "..", "golden")
FIXTURES_DIR = os.path.join(HERE, "fixtures")

os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
# production defaults, identical to tests/golden/make_golden.py (_PINNED_ENV)
_PINNED_ENV = {
    "LEVELS_REGIME_GATE": "enforce",
    "LEVELS_VOL_GATE": "off",
    "LEVELS_ENTRY_CONFIRM": "off",
    "LEVELS_MAX_ATR_PCT": "2.5",
    "LEVELS_MIN_RR": "1.8",
    "LEVELS_RELAX_ENABLED": "0",
    "SL_V2_SMC_ENABLED": "0",
    "SL_V2_LEVELS_ENABLED": "0",
    "SQUEEZE_BB_LOOKBACK": "50",
    "SQUEEZE_BB_PCTILE_STRONG": "15",
    "SQUEEZE_BB_PCTILE_SOME": "30",
    "SQUEEZE_ATR_RATIO_STRONG": "0.7",
    "SQUEEZE_ATR_RATIO_SOME": "0.85",
    "CACHE_FIRST_MODE": "off",
    "BACKTEST_DISABLE_BE_MOVE": "0",
}
for _k, _v in _PINNED_ENV.items():
    os.environ[_k] = _v

sys.dont_write_bytecode = True
sys.path.insert(0, BOT_DIR)
os.chdir(BOT_DIR)

import logging  # noqa: E402

logging.disable(logging.WARNING)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402


def load_df(symbol: str, tf: str) -> pd.DataFrame:
    """Golden candle fixture → DataFrame exactly like make_golden.load_df (naive UTC index)."""
    with open(os.path.join(GOLDEN_DIR, "candles", f"{symbol}_{tf}.json")) as fh:
        fx = json.load(fh)
    arr = np.array(fx["bars"], dtype=float)
    idx = pd.to_datetime(arr[:, 0].astype("int64"), unit="ms")
    df = pd.DataFrame({"open": arr[:, 1], "high": arr[:, 2], "low": arr[:, 3],
                       "close": arr[:, 4], "volume": arr[:, 5]}, index=idx)
    df.index.name = "open_time"
    return df


def jsonable(x):
    """inf / nan → strings (JSON has no literals for them); numpy scalars → Python."""
    if isinstance(x, dict):
        return {str(k): jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [jsonable(v) for v in x]
    if isinstance(x, (np.floating,)):
        x = float(x)
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.bool_,)):
        return bool(x)
    if isinstance(x, float):
        if math.isnan(x):
            return "nan"
        if math.isinf(x):
            return "inf" if x > 0 else "-inf"
    return x


def write_fixture(name: str, doc) -> str:
    """fixtures/<name>.gz — gzip (mtime 0, so a re-run with the same inputs is byte-identical)."""
    import gzip
    os.makedirs(FIXTURES_DIR, exist_ok=True)
    path = os.path.join(FIXTURES_DIR, name + ".gz")
    raw = json.dumps(jsonable(doc), ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n"
    with open(path, "wb") as fh:
        with gzip.GzipFile(filename="", mode="wb", fileobj=fh, mtime=0) as gz:
            gz.write(raw)
    return path
