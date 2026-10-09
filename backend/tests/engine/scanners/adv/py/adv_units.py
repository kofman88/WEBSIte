"""adv_units.py — unit vectors behind the adversarial scanner differential (adv_drive.py) for the
config parsers every scanner calls per user per cycle (backend/tests/engine/scanners/adv/adv_units.test.js):

  user_manager._sparse_merge(base, override_json)   get_long_cfg / get_short_cfg (LEVELS)
  TradeCfg.from_json(s)
  SMCUserCfg.from_json(s)                          get_smc_cfg (SMC, Mini App)
  handlers._common._load_sparse(raw_json)           the settings handlers
  smc.signal_builder.calculate_levels(a, dir, cfg)  [SMC-LIQUIDITY-AWARE-SL] INFO line ("CHM.SMC.SignalBuilder")

Each vector records the result (dataclass dict) or the exception (type name + str) and the
WARNING+ log lines the call wrote. Run from the bot checkout (read-only):
  cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && PYTHONDONTWRITEBYTECODE=1 BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \
     <py311> <site>/backend/tests/engine/scanners/adv/py/adv_units.py
"""
from __future__ import annotations

import json
import logging
import math
import os
import sys
import tempfile

sys.dont_write_bytecode = True
BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "..", "fixtures", "adv_units.json")
os.chdir(BOT)
sys.path.insert(0, BOT)
os.environ["BOT_TOKEN_CHM"] = "test:token"
os.environ["ADMIN_IDS"] = "123"
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(prefix="adv_units_"), "bot.db")

from dataclasses import asdict  # noqa: E402

import user_manager as um_mod  # noqa: E402
from user_manager import SMCUserCfg, TradeCfg  # noqa: E402


class Capture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.INFO)
        self.lines = []

    def emit(self, record):
        self.lines.append([record.name, record.levelname, record.getMessage()])


CAP = Capture()
root = logging.getLogger()
root.setLevel(logging.WARNING)
logging.getLogger("CHM.SMC.SignalBuilder").setLevel(logging.INFO)
for h in list(root.handlers):
    root.removeHandler(h)
root.addHandler(CAP)


def enc(x):
    if isinstance(x, float) and not math.isfinite(x):
        return {"$f": "nan" if math.isnan(x) else ("inf" if x > 0 else "-inf")}
    if isinstance(x, dict):
        return {str(k): enc(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [enc(v) for v in x]
    return x


INPUTS = [
    "", "{}", "{bad json", "[1, 2]", "null", "1", "1.5", '"x"', "true", "[]",
    '{"min_rr": NaN, "_sparse": true}',
    '{"min_rr": Infinity, "_sparse": true}',
    '{"tp1_rr": 2.0, "min_rr": 2.0, "pivot_strength": 5}',
    '{"tp1_rr": 2.0000001, "min_volume_usdt": 300000.0, "zone_pct": 0.70000001}',
    '{"min_volume_usdt": 300000.15, "cooldown_bars": 5}',
    '{"min_rr": 1.5, "max_dist_pct": 3.0, "_sparse": true}',
    '{"min_rr": 1.5, "min_rr": 2.5, "_sparse": true}',
    '{"_sparse": false, "rsi_ob": 65, "rsi_os": 30}',
    '{"_sparse": 1, "unknown": 5, "timeframe": "4h"}',
    ' {"pivot_strength": 3, "_sparse": true} ',
    '{"tf_key": "4H", "min_confirmations": 2}',
    '{"tf_key": "15m", "scan_interval": 900, "direction": "LONG", "min_rr": NaN}',
    '{"min_volume_usdt": 0, "foo": 1}',
    '{"scan_interval": "300"}',
    # TypeError texts name both operand types: defaults are floats, JSON literals keep theirs
    '{"tp1_rr": "x"}',
    '{"tp2_rr": "x", "tp1_rr": 2, "_sparse": true}',
    '{"tp2_rr": "x", "tp1_rr": 2.0, "_sparse": true}',
    '{"tp3_rr": null, "_sparse": true}',
    '{"tp1_rr": "a", "min_rr": "b", "_sparse": true}',
    '{"tp1_rr": "b", "min_rr": "a", "tp2_rr": 9.0, "_sparse": true}',
    '{"min_quality": "5", "_sparse": true}',
    '{"min_quality": true, "vol_mult": false, "_sparse": true}',
    '{"vol_mult": [1], "_sparse": true}',
    '{"vol_mult": NaN, "min_quality": -Infinity, "_sparse": true}',
    '{"max_risk_pct": {}, "_sparse": true}',
    '{"cooldown_bars": "x", "_sparse": true}',
    '{"scan_interval": 30.0, "min_rr": 0, "_sparse": true}',
    '{"min_rr": 1, "tp1_rr": "z", "_sparse": true}',
    '﻿{}',
    '{"a": 1} x',
]


def run(fn, s):
    CAP.lines.clear()
    try:
        r = fn(s)
        out = {"ok": enc(r)}
    except Exception as e:  # noqa: BLE001
        out = {"error": [type(e).__name__, str(e)]}
    out["logs"] = list(CAP.lines)
    return out


def _levels_cases():
    """calculate_levels inputs around the liquidity-aware SL: magnets inside / outside the 0.5 %
    danger zone, capped at 0.6 %, symbol missing / None, no liquidity, both directions."""
    base = {"ob": {"bull_ob": {"found": True, "ob_low": 100.0, "ob_high": 101.0},
                   "bear_ob": {"found": True, "ob_low": 104.0, "ob_high": 105.0}},
            "fvg": {}, "structure": {}, "atr": 0.2, "current_price": 102.5}
    cases = []
    for sym in ["SYNX-USDT-SWAP", None, "<missing>", "PEPE-USDT-SWAP"]:
        for lows, highs in [([99.55], [105.5]), ([99.2, 99.6], [105.3, 105.9]), ([97.0], [110.0]),
                            ([99.8], [105.2]), ([], []), (None, None), ([99.45, 0.0], [105.55, -1.0])]:
            a = dict(base)
            if sym != "<missing>":
                a["symbol"] = sym
            if lows is None:
                a["liquidity"] = {}
            else:
                a["liquidity"] = {"equal_lows": [{"price": p} for p in lows],
                                  "equal_highs": [{"price": p} for p in highs]}
            for d in ("LONG", "SHORT"):
                cases.append((a, d))
    return cases


def main():
    from handlers import _common
    from smc.analyzer import SMCConfig
    from smc import signal_builder as _sb
    vectors = []
    base = TradeCfg()
    for s in INPUTS:
        vectors.append({
            "input": s,
            "sparse_merge": run(lambda x: asdict(um_mod._sparse_merge(base, x)), s),
            "trade_from_json": run(lambda x: asdict(TradeCfg.from_json(x)), s),
            "smc_from_json": run(lambda x: asdict(SMCUserCfg.from_json(x)), s),
            "load_sparse": run(lambda x: _common._load_sparse(x), s),
        })
    levels = []
    for a, d in _levels_cases():
        levels.append({"analysis": a, "direction": d,
                       **run(lambda x: _sb.calculate_levels(x, d, SMCConfig()), a)})
    doc = {"meta": {"generator": "tests/engine/scanners/adv/py/adv_units.py", "python": sys.version.split()[0]},
           "vectors": vectors, "levels": levels}
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(doc, ensure_ascii=False, indent=1, allow_nan=False) + "\n")
    print("wrote", OUT, len(vectors), "vectors")


if __name__ == "__main__":
    main()
    sys.stdout.flush()
    os._exit(0)
