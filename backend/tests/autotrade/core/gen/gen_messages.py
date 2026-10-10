"""gen_messages.py — the i18n.MESSAGES entries the auto-trade flow sends, copied from the bot.

Writes backend/services/autotrade/messagesData.json ({key: {ru, en}}) so the JS port renders
exactly the bot's texts (services/autotrade/messages.js applies str.format semantics).

Run from the bot checkout with the production interpreter:
  cd /home/user/MAIN_BOT/CHM_BREAKER_V4
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 $PY311 <worktree>/backend/tests/autotrade/core/gen/gen_messages.py
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import json
import os
import sys

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "services", "autotrade", "messagesData.json"))
sys.path.insert(0, BOT)
os.chdir(BOT)

import i18n  # noqa: E402

KEYS = [
    # auto_trade.py
    "counter_trend", "counter_trend_label",
    "regime_trending_up", "regime_trending_down", "regime_ranging", "regime_high_vol",
    "auto_trade_limit", "auto_trade_cross_direction", "auto_trade_timeout",
    "auto_trade_timeout_reconciled", "auto_trade_timeout_unknown", "auto_trade_error", "auto_trade_limit_unfilled",
    "smc_sl_too_wide", "zb_cooldown_set_notif", "low_notional_skip_notif",
    "leverage_downgrade_warning", "risk_capped_warning", "risk_boosted_warning",
    "tp_placement_failed", "signal_skipped_stale", "circuit_breaker_notif", "sl_streak_notif",
    # _notify_skip_to_user
    "skip_notify_counter_trend", "skip_notify_max_sl", "skip_notify_ml_filter",
    "skip_notify_hour_filter", "skip_notify_sl_streak", "skip_notify_funding",
    "skip_notify_low_balance", "skip_notify_disabled_day", "skip_notify_generic",
    # partial_tp.py
    "tp_ladder_downgrade",
    # M15 BE monitor (scanner_mid.py _check_breakevens / _notify_trailing_fail; i18n.py unchanged
    # between 37a888f and 1a47ffc — the gN fixes added no keys; reconcile, SL verifier, anomaly
    # detector and orphan sweeper send no i18n texts)
    "limit_order_cancelled", "trade_auto_closed",
    "trade_closed_tp1", "trade_closed_tp2", "trade_closed_tp3", "trade_closed_sl", "trade_closed_be",
    "trade_closed_trail_profit", "trade_closed_trail_loss", "trade_closed_trail_be",
    "trade_closed_manual_profit", "trade_closed_manual_loss", "trade_closed_manual_be",
    "trade_closed_auto_profit", "trade_closed_auto_loss", "trade_closed_auto_be", "trade_closed_generic",
    "trade_balance", "trailing_stop_updated", "trailing_level_be", "trailing_level_plus_r",
    "trailing_sl_failed", "tp_placement_failed_warning",
]

out = {}
for k in KEYS:
    entry = i18n.MESSAGES[k]
    out[k] = {lang: entry[lang] for lang in sorted(entry)}

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1, sort_keys=True)
    f.write("\n")
print(f"wrote {len(out)} keys → {OUT}")
