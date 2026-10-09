"""gen_e2e_messages.py — the bot's own texts for backend/tests/autotrade/e2e/autotradeE2E.test.js
(fixture ../fixtures/e2e_messages.json).

Input: the capture the E2E writes with E2E_CAPTURE=<file> — every format_trade_result call the site
made (auto open per exchange, confirm exec, the killswitch-halted exec, the expiry-window exec):
{"fmt": {"<group>:<exchange>": {"exchange", "args": [result, direction, symbol, entry, sl, tp1,
risk_pct, leverage, tp2, tp3]}}, "users": {"<group>:<exchange>": uid}}.

Output per key: {"inputs": {"args"}, "text"} where text is what the bot would send for those inputs:
  auto     auto_trade.py execute_auto_trade's message: fmt_fn(*fmt_args, tp2=, tp3=) (+ regime warning:
           none here) + the [W1.2 RISK-PREVIEW] block run as the bot runs it (balance_cache with a
           SimpleNamespace(user_id) — a cold cache answers None, so no line is appended)
  confirm / halt / window   handlers/trading.py exec_trade: the trader's format_trade_result(...)
and "i18n": the card texts of exec_trade (exec_opening, exec_already_opened, RU).

Types: JSON loses int / float; the bot passes entry / sl / tp1 / tp2 / tp3 / risk_pct as float
(trade rows and trader_settings REAL columns) and leverage as int — restored here; the trader's
result dict is used as the site's trader returned it (its shape is pinned by the trader parity
suites).

  cd /home/user/MAIN_BOT/CHM_BREAKER_V4
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> -I -B <site>/backend/tests/autotrade/e2e/gen/gen_e2e_messages.py CAPTURE [OUT]
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from types import SimpleNamespace

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
HERE = os.path.dirname(os.path.abspath(__file__))
SITE_BACKEND = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
EXPY = os.path.join(SITE_BACKEND, "tests", "exchanges", "py")
CAPTURE = os.path.abspath(sys.argv[1])
OUT = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.join(HERE, "..", "fixtures", "e2e_messages.json")
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
sys.dont_write_bytecode = True
os.chdir(BOT)
sys.path.insert(0, BOT)
sys.path.insert(0, EXPY)

import harness  # noqa: E402,F401  (the four traders with the replay fakes installed — no network)
import bybit_trader  # noqa: E402
import bingx_trader  # noqa: E402
import binance_trader  # noqa: E402
import okx_trader  # noqa: E402
import balance_cache  # noqa: E402
import risk_preview  # noqa: E402
from i18n import t as i18n_t  # noqa: E402

MODS = {"bybit": bybit_trader, "bingx": bingx_trader, "binance": binance_trader, "okx": okx_trader}


def typed(args):
    res, direction, symbol, entry, sl, tp1, risk_pct, leverage, tp2, tp3 = args
    return res, direction, symbol, float(entry), float(sl), float(tp1), float(risk_pct), int(leverage), float(tp2), float(tp3)


async def auto_message(uid, exchange, args):
    """execute_auto_trade: trade_msg = fmt_fn(*fmt_args, tp2=tp2, tp3=tp3) + the risk-preview block."""
    trade_result, direction, symbol, entry, sl, tp1, risk_pct, leverage, tp2, tp3 = typed(args)
    fmt_fn = MODS[exchange].format_trade_result
    trade_msg = fmt_fn(trade_result, direction, symbol, entry, sl, tp1, risk_pct, leverage, tp2=tp2, tp3=tp3)
    # result["regime_warning"] (execute_auto_trade's own dict, not an input here): none on this signal —
    # the E2E compares the whole delivered body, so a warning would show up as a difference
    _qty_for_preview = float(trade_result.get("qty", 0) or 0) if isinstance(trade_result, dict) else 0.0
    _bal = await balance_cache.get_cached_balance(SimpleNamespace(user_id=uid), exchange)
    if _qty_for_preview > 0 and _bal and _bal > 0 and entry > 0 and sl > 0:
        raise SystemExit("the balance cache answered a balance — the E2E expects the bot's cold-cache path")
    return trade_msg


def exec_message(exchange, args):
    """exec_trade: text = <trader>.format_trade_result(result, ..., tp2, tp3)."""
    result, direction, symbol, entry, sl, tp1, risk_pct, leverage, tp2, tp3 = typed(args)
    return MODS[exchange].format_trade_result(result, direction, symbol, entry, sl, tp1, risk_pct, leverage, tp2, tp3)


async def main():
    cap = json.load(open(CAPTURE, encoding="utf-8"))
    out = {}
    for key in sorted(cap["fmt"]):
        group, exchange = key.split(":")
        args = cap["fmt"][key]["args"]
        if group == "auto":
            text = await auto_message(cap["users"][key], exchange, args)
        else:
            text = exec_message(exchange, args)
        out[key] = {"inputs": {"args": args}, "text": text}
    out["i18n"] = {k: i18n_t(k, "ru") for k in ("exec_opening", "exec_already_opened")}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    print(f"wrote {OUT}: {len(out) - 1} messages", file=sys.stderr)


asyncio.run(main())
