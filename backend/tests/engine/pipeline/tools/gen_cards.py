"""gen_cards.py — the bot's card renderers applied to the JS engine signal objects.

Run from the bot checkout (read-only use of its modules):

  cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \
    <venv>/bin/python <site>/backend/tests/engine/pipeline/tools/gen_cards.py
  rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json

Input : fixtures/card_signals.json (tools/dumpCardSignals.js — JS engine objects).
Output: fixtures/cards.json — every case carries the scenario (BTC trend state),
        the mutation applied to the signal and the exact strings the bot produces:
        full card (RU/EN), lite card (RU/EN), keyboards, the scanner assembly
        (watermark → SL warning → position line → confluence for SMC), plus the
        i18n entries the JS card modules copy.
"""
from __future__ import annotations

import asyncio
import copy
import dataclasses
import json
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "..", "fixtures")
sys.path.insert(0, os.getcwd())

import i18n  # noqa: E402
import trend_monitor as tm  # noqa: E402
import scanner_mid  # noqa: E402
import volume_scanner  # noqa: E402
import signal_format  # noqa: E402
import position_size  # noqa: E402
import balance_cache  # noqa: E402
import signal_confluence  # noqa: E402
from watermark import wm_inject  # noqa: E402
from indicator import SignalResult  # noqa: E402
from smc.signal_builder import SMCSignalResult  # noqa: E402
from smc import scanner as smc_scanner  # noqa: E402
from volume_strategy import VolumeSignal  # noqa: E402

# BTC trend states the cards are rendered under (trend_monitor._state / _strength).
SCENARIOS = [
    {"trend": {}, "strength": {}},
    {"trend": {"15m": "LONG", "1H": "LONG", "4H": "SHORT"}, "strength": {"15m": 55}},
    {"trend": {"15m": "SHORT", "1H": "SHORT", "4H": "SHORT", "1D": "LONG"}, "strength": {"15m": 85, "1H": 90}},
    {"trend": {"15m": "RANGE", "1H": "LONG", "4H": "LONG", "1W": "SHORT"}, "strength": {"15m": 40}},
    {"trend": {"15m": "LONG", "1H": "LONG", "4H": "LONG"}, "strength": {"15m": 70}},
    {"trend": {"15m": "SHORT", "1H": "LONG", "4H": "SHORT", "1D": "RANGE"}, "strength": {"15m": 69}},
]
LEVELS_TFS = ["1h", "15m", "4h", "30m", "1d", "1H"]
CORRS = [(0.71, 0.66), (0.7, 0.1), (0.1, 0.9), (-0.2, 0.25), (0.5, 0.2), (0.65, 0.3), (0.3, 0.3)]


def set_trend(sc):
    tm._state.clear()
    tm._strength.clear()
    for tf, t in sc["trend"].items():
        tm._state[tf] = {"trend": t, "since": 0.0, "price": 0.0}
    for tf, s in sc["strength"].items():
        tm._strength[tf] = s


def make(cls, d):
    names = {f.name for f in dataclasses.fields(cls)}
    kw = {k: v for k, v in d.items() if k in names}
    if cls is SMCSignalResult:
        kw["confirmations"] = [tuple(x) for x in kw["confirmations"]]
    return cls(**kw)


def apply(sig, mutation):
    for k, v in mutation.items():
        setattr(sig, k, v)
    return sig


def kb_rows(markup):
    rows = []
    for row in markup.inline_keyboard:
        out = []
        for b in row:
            if b.url:
                out.append({"text": b.text, "url": b.url})
            else:
                out.append({"text": b.text, "callback_data": b.callback_data})
        rows.append(out)
    return rows


async def pos_line(user, entry, sl, lang, ctx, balance):
    async def fake_balance(_u, _ex):
        return balance
    balance_cache.get_cached_balance = fake_balance
    return await position_size.position_line(user, entry, sl, lang, ctx=ctx)


def levels_cases(items):
    out = []
    for idx, it in enumerate(items):
        sc_i = idx % len(SCENARIOS)
        tf = LEVELS_TFS[idx % len(LEVELS_TFS)]
        b, e = CORRS[idx % len(CORRS)]
        mutation = {"btc_corr": b, "eth_corr": e}
        if idx % 3 == 1:
            mutation["_sq_boosted"] = True
        if idx == 5:
            mutation.update({"symbol": "A<B>&C-USDT-SWAP", "breakout_type": "Пробой \"x\" & <y>",
                             "human_explanation": "Тест <i>экранирования</i> & 'кавычек'",
                             "trend_local": "Тренд <вверх> & \"x\"", "reasons": []})
        if idx == 7:
            mutation.update({"quality": 10, "is_counter_trend": True})
        if idx == 8:
            mutation.update({"quality": 0})
        set_trend(SCENARIOS[sc_i])
        sig = apply(make(SignalResult, it["signal"]), mutation)
        cfg = types.SimpleNamespace(timeframe=tf)
        case = {"source": it["source"], "scenario": sc_i, "timeframe": tf, "mutation": mutation, "out": {}}
        for lang in ("ru", "en"):
            case["out"][f"full_{lang}"] = scanner_mid.signal_text(sig, cfg, lang)
            case["out"][f"lite_{lang}"] = signal_format.format_signal_lite(
                symbol=sig.symbol, direction=sig.direction, quality=sig.quality, entry=sig.entry, sl=sig.sl,
                tp1=sig.tp1, tp2=getattr(sig, "tp2", None), tp3=getattr(sig, "tp3", None),
                strategy="LEVELS", lang=lang, quality_scale=10)
            case["out"][f"kb_{lang}"] = kb_rows(scanner_mid.signal_compact_keyboard(
                f"777_{idx}", sig.symbol, show_trade_btn=idx % 2 == 0,
                is_counter_trend=bool(sig.is_counter_trend), is_auto_traded=idx % 4 == 1, lang=lang))
        out.append(case)
    return out


def smc_cases(items):
    out = []
    users = [
        {"user_id": 123456789, "smc_max_sl_pct": 5.0, "trade_risk_pct": 1.0, "trade_leverage": 10},
        {"user_id": 987654321012, "smc_max_sl_pct": 1.0, "trade_risk_pct": 2.5, "trade_leverage": 3},
        {"user_id": 42, "smc_max_sl_pct": 0, "trade_risk_pct": 0.75, "trade_leverage": 20},
        {"user_id": 7, "trade_risk_pct": 1.0, "trade_leverage": 10},
    ]
    balances = [None, 2500.0, 0.0, 87.5]
    ctxs = ["", "aligned", "with", "counter", "strong_counter"]
    for idx, it in enumerate(items):
        sc_i = idx % len(SCENARIOS)
        mutation = {}
        if idx % 5 == 2:
            mutation["mode_tag"] = ""
        fund = "📰 Новости: <b>спокойно</b> & без сюрпризов" if idx % 4 == 3 else ""
        set_trend(SCENARIOS[sc_i])
        sig = apply(make(SMCSignalResult, it["signal"]), mutation)
        u_i = idx % len(users)
        user = types.SimpleNamespace(**users[u_i])
        ctx = ctxs[idx % len(ctxs)]
        bal = balances[idx % len(balances)]
        # confluence state: 0, 1 or 2 other strategies recorded for (symbol, direction)
        signal_confluence.reset_for_tests()
        others = ["LEVELS", "VOLUME"][: idx % 3]
        for s in others:
            signal_confluence.record_signal(sig.symbol, sig.direction, s, 3)
        case = {"source": it["source"], "scenario": sc_i, "mutation": mutation, "fund_block": fund,
                "user": users[u_i], "ctx": ctx, "balance": bal, "confluence_others": others, "out": {}}
        for lang in ("ru", "en"):
            raw = smc_scanner._signal_text_smc(sig, fund, lang=lang)
            case["out"][f"full_{lang}"] = raw
            q = getattr(sig, "score", None) or getattr(sig, "quality", None) or 0
            lite = signal_format.format_signal_lite(
                symbol=sig.symbol, direction=sig.direction, quality=q, entry=sig.entry, sl=sig.sl,
                tp1=sig.tp1, tp2=getattr(sig, "tp2", None), tp3=getattr(sig, "tp3", None),
                strategy="SMC", lang=lang)
            case["out"][f"lite_{lang}"] = lite
            for kind, base in (("assembled", raw), ("assembled_lite", lite)):
                text = wm_inject(base, user.user_id)
                text = smc_scanner._maybe_append_smc_sl_warning(text, sig, user, lang)
                pl = asyncio.run(pos_line(user, sig.entry, sig.sl, lang, ctx, bal))
                if pl:
                    text += "\n" + pl
                label = signal_confluence.get_confluence_label(sig.symbol, sig.direction, current_strategy="SMC")
                if label:
                    text = f"{label}\n{text}"
                case["out"][f"{kind}_{lang}"] = text
            case["out"][f"kb_{lang}"] = kb_rows(smc_scanner._smc_keyboard(
                sig.symbol, f"555_{idx}" if idx % 7 else "", show_trade_btn=idx % 2 == 0,
                is_auto_traded=idx % 3 == 1, lang=lang))
        out.append(case)
    return out


def volume_cases(items):
    out = []
    for idx, it in enumerate(items):
        sc_i = idx % len(SCENARIOS)
        mutation = {}
        if idx % 4 == 1:
            mutation["squeeze"] = 1
        if idx % 4 == 3:
            mutation["squeeze"] = 2
        if idx == 6:
            mutation.update({"ma_value": 0.0, "htf_tf": "", "ma_names": "", "ema_names": ""})
        if idx == 9:
            mutation.update({"setup": "", "alignment": "", "signal_type": "Custom <type> & co"})
        if idx == 10:
            mutation.update({"reasons": ["a <b>", "c & d", "e", "f", "g — пятая"], "alignment": "SMA10 > SMA20 & EMA"})
        if idx == 11:
            mutation.update({"quality": 9, "htf_state": -1})
        set_trend(SCENARIOS[sc_i])
        sig = apply(make(VolumeSignal, it["signal"]), mutation)
        case = {"source": it["source"], "scenario": sc_i, "mutation": mutation, "out": {}}
        for lang in ("ru", "en", "de"):
            case["out"][f"full_{lang}"] = volume_scanner.signal_text(sig, lang)
        for lang in ("ru", "en"):
            case["out"][f"lite_{lang}"] = signal_format.format_signal_lite(
                symbol=sig.symbol, direction=sig.direction, quality=int(sig.quality),
                entry=sig.entry, sl=sig.sl, tp1=sig.tp1, tp2=sig.tp2, tp3=sig.tp3,
                strategy=volume_scanner.STRATEGY_NAME, lang=lang)
            case["out"][f"kb_{lang}"] = kb_rows(scanner_mid.signal_compact_keyboard(
                f"9_vol_{idx}", sig.symbol, show_trade_btn=idx % 3 == 0, is_auto_traded=idx % 2 == 1, lang=lang))
        out.append(case)
    return out


I18N_KEYS = [
    "levels_long_header", "levels_short_header", "counter_trend_header", "counter_trend_warn",
    "quality_factors", "analysis_label", "target1", "target2", "target3", "levels_footer",
    "fundamental_header", "entry", "stop_loss", "record_result", "quality_label",
    "smc_long_header", "smc_short_header", "smc_tf_label", "smc_entry_zone", "smc_tp1_pct",
    "smc_tp2_pct", "smc_tp3_pct", "smc_confirmations", "smc_entry_logic", "smc_sl_inline_warning",
    "signal_chart_btn", "signal_stats_btn", "signal_record_btn", "signal_open_trade_btn",
    "signal_counter_trend_help_btn",
]


def main():
    with open(os.path.join(FIX, "card_signals.json"), encoding="utf-8") as fh:
        src = json.load(fh)
    doc = {
        "note": "Bot card renderers on JS engine signal objects (tools/gen_cards.py).",
        "scenarios": SCENARIOS,
        "levels": levels_cases(src["levels"]),
        "smc": smc_cases(src["smc"]),
        "volume": volume_cases(src["volume"]),
        "i18n": {k: {"ru": i18n.MESSAGES[k].get("ru"), "en": i18n.MESSAGES[k].get("en")} for k in I18N_KEYS},
        "trade_records_kb": kb_rows(scanner_mid.trade_records_keyboard("777_1")),
    }
    with open(os.path.join(FIX, "cards.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print("levels=%d smc=%d volume=%d" % (len(doc["levels"]), len(doc["smc"]), len(doc["volume"])))


if __name__ == "__main__":
    main()
