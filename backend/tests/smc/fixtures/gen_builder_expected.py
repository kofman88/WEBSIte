"""Generate backend/tests/smc/fixtures/builder_expected.json from the bot's own
smc/signal_builder.py + liquidity_sl_adjuster.py on hand-built analysis dicts.

Run from /home/user/MAIN_BOT/CHM_BREAKER_V4 with the pinned venv:
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/python -I <this file> <out.json>
"""
import dataclasses
import json
import math
import sys

sys.path.insert(0, "/home/user/MAIN_BOT/CHM_BREAKER_V4")

from smc.signal_builder import (  # noqa: E402
    build_smc_signal, calculate_levels, _check_retrace_with_depth, _compute_mode_tag,
    score_bullish, score_bearish, generate_narrative, _adjust_sl_for_liquidity,
)
from smc.analyzer import SMCConfig  # noqa: E402
from smc.scanner import _rr_ladder, _rr_ladder_text, _analysis_key  # noqa: E402
from liquidity_sl_adjuster import adjust_sl_for_magnets  # noqa: E402
from user_manager import SMCUserCfg  # noqa: E402


def r10(x):
    if isinstance(x, bool):
        return x
    if isinstance(x, int):
        return x
    if isinstance(x, float):
        if math.isnan(x) or math.isinf(x):
            return None
        return float(f"{x:.10g}")
    if isinstance(x, dict):
        return {str(k): r10(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [r10(v) for v in x]
    return x


def ob(found, lo, hi, typ, mitigated=True, ob50=True, breaker=False, imp=None, bar_ago=5):
    return dict(found=found, ob_low=lo, ob_high=hi, ob_mid=(lo + hi) / 2, ob_50_reached=ob50,
                type=typ, mitigated=mitigated, bar_ago=bar_ago, is_breaker=breaker, impulse_fvg=imp)


def fvg(typ, lo, hi, inversed=False, idx=10):
    return dict(type=typ, fvg_low=lo, fvg_high=hi, gap_pct=0.2, bar_ago=3, idx=idx, filled=False, inversed=inversed)


def analysis(symbol="SYN-USDT-SWAP", trend="RANGING", choch=None, bos=None, sweep_up=None, sweep_down=None,
             eq_highs=(), eq_lows=(), bull_ob=None, bear_ob=None, bull_fvg=None, bear_fvg=None,
             zone="NEUTRAL", pos=50.0, atr=0.5, cp=100.0, ch=None, cl=None, vol_ratio=1.5,
             sh=None, sl=None, squeeze=0, bos_ws=False, choch_ws=False, error=None):
    empty = dict(detected=False, price=0.0, direction="", bar_ago=0, wick_sweep=False)
    return dict(
        symbol=symbol,
        structure=dict(trend=trend, swing_highs=[], swing_lows=[], bos=bos or dict(empty), choch=choch or dict(empty),
                       last_swing_high=sh, last_swing_low=sl, bos_wick_sweep=bos_ws, choch_wick_sweep=choch_ws),
        liquidity=dict(equal_highs=[dict(price=p, count=2, levels=[p, p], type="EQH") for p in eq_highs],
                       equal_lows=[dict(price=p, count=2, levels=[p, p], type="EQL") for p in eq_lows],
                       sweep_up=sweep_up or dict(swept=False, level=0.0, direction="UP"),
                       sweep_down=sweep_down or dict(swept=False, level=0.0, direction="DOWN")),
        ob=dict(bull_ob=bull_ob or ob(False, 0.0, 0.0, ""), bear_ob=bear_ob or ob(False, 0.0, 0.0, "")),
        fvg=dict(all_fvgs=[], ifvgs=[], bull_fvg=bull_fvg, bear_fvg=bear_fvg,
                 bull_found=bull_fvg is not None, bear_found=bear_fvg is not None),
        pd_zone=dict(zone=zone, position_pct=pos),
        error=error, atr=atr, current_price=cp, current_high=ch if ch is not None else cp, current_low=cl if cl is not None else cp,
        volume_ok=vol_ratio >= 1.2, vol_ratio=vol_ratio, vol_last=100.0, vol_avg=100.0 / vol_ratio if vol_ratio else 0.0,
        squeeze_score=squeeze,
    )


def cfg_from_user(overrides, high_wr):
    ucfg = SMCUserCfg(**overrides)
    c = SMCConfig()
    c.MIN_CONFIRMATIONS = ucfg.min_confirmations
    c.MIN_RR = ucfg.min_rr
    c.SL_BUFFER_PCT = ucfg.sl_buffer_pct
    c.FVG_ENABLED = ucfg.fvg_enabled
    c.CHOCH_ENABLED = ucfg.choch_enabled
    c.OB_USE_BREAKER = ucfg.ob_use_breaker
    c.OB_MAX_AGE_CANDLES = ucfg.ob_max_age
    c.SWEEP_CLOSE_REQUIRED = ucfg.sweep_close_req
    c.VOL_MULT = float(getattr(ucfg, "smc_vol_mult", 1.2) or 1.2)
    c.VOL_LEN = int(getattr(ucfg, "smc_vol_len", 20) or 20)
    c.USE_VOLUME_FILTER = bool(getattr(ucfg, "smc_use_volume_filter", False))
    key = _analysis_key(c)
    if high_wr:
        c.MIN_CONFIRMATIONS = max(c.MIN_CONFIRMATIONS, 4)
        pd_f, mtf = True, True
    else:
        pd_f, mtf = ucfg.smc_pd_filter, ucfg.smc_mtf_check
    kw = dict(tf_htf="4H", tf_mtf="1H", tf_ltf="15m", allowed_dirs=["LONG", "SHORT"],
              conf_type=ucfg.smc_conf_type, pd_filter=pd_f, retrace_depth=ucfg.smc_retrace_depth, mtf_check=mtf)
    cfgd = {k: getattr(c, k) for k in dir(c) if k.isupper() and not k.startswith("_")}
    return c, cfgd, list(key), kw, dataclasses.asdict(ucfg)


def sig_dict(sig, cfg):
    if sig is None:
        return None
    d = dataclasses.asdict(sig)
    d["confirmations"] = [[l, bool(v)] for l, v in d["confirmations"]]
    d["rr_ladder"] = list(_rr_ladder(sig))
    d["rr_ladder_text"] = _rr_ladder_text(sig)
    d["passes_ctx_gate"] = bool(int(sig.score) >= int(cfg.MIN_CONFIRMATIONS))
    return d


# ── cases ────────────────────────────────────────────────────────────────────
# A "rich" LONG setup: bullish OB 98..100 mitigated, bull FVG 101.5..102 (beyond zone), swing high 104,
# equal highs 106 / 103 (tp3 = min above tp2 = 106), equal lows near the SL to trigger the magnet push.
rich_long = analysis(
    trend="BULLISH", bull_ob=ob(True, 98.0, 100.0, "bullish", imp=dict(type="bullish", fvg_low=98.5, fvg_high=99.0, idx=3, bar_ago=4)),
    bull_fvg=fvg("bullish", 101.5, 102.0), sh=dict(price=104.0, idx=190, bar=190), sl=dict(price=95.0, idx=180, bar=180),
    eq_highs=(106.0, 103.0, 110.0), eq_lows=(97.5, 90.0), zone="DISCOUNT", pos=35.4, atr=0.4, cp=99.0, ch=99.5, cl=98.4,
    vol_ratio=1.5, sweep_up=dict(swept=True, level=97.2, direction="UP", wick_ratio=0.512), squeeze=1,
)
rich_short = analysis(
    trend="BEARISH", bear_ob=ob(True, 100.0, 102.0, "bearish"),
    bear_fvg=fvg("bearish", 98.0, 98.5, inversed=True), sh=dict(price=105.0, idx=190, bar=190), sl=dict(price=96.0, idx=180, bar=180),
    eq_highs=(102.6, 110.0), eq_lows=(94.0, 97.0, 80.0), zone="PREMIUM", pos=71.2, atr=0.4, cp=101.0, ch=101.6, cl=100.5,
    vol_ratio=0.9, sweep_down=dict(swept=True, level=102.8, direction="DOWN", wick_ratio=0.4), squeeze=2,
)
# both OBs found, both directions score equally → tie → LONG
tie = analysis(
    trend="RANGING", bull_ob=ob(True, 98.0, 100.0, "bullish"), bear_ob=ob(True, 100.0, 102.0, "bearish"),
    bull_fvg=fvg("bullish", 101.5, 102.0), bear_fvg=fvg("bearish", 97.0, 97.5),
    sh=dict(price=106.0, idx=1, bar=1), sl=dict(price=94.0, idx=2, bar=2), atr=0.4, cp=100.0, ch=100.5, cl=99.5, vol_ratio=1.5,
)
# invalid ladder: swing high too close to tp1 (gap < 0.3R) → fallback 1.2/2.5/4.0 from entry_mid, rr_structural pinned
ladder_bad = analysis(
    trend="BULLISH", bull_ob=ob(True, 98.0, 100.0, "bullish"), bull_fvg=fvg("bullish", 101.0, 101.5),
    sh=dict(price=101.6, idx=1, bar=1), atr=0.4, cp=99.0, ch=99.5, cl=98.4, vol_ratio=1.5, zone="DISCOUNT",
)
# structural TP2 below MIN_RR but ladder fallback would give 2.5 → must be rejected by [SMC-LADDER]
ladder_rescue = analysis(
    trend="BULLISH", bull_ob=ob(True, 98.0, 100.0, "bullish"), bull_fvg=fvg("bullish", 100.2, 100.4),
    sh=dict(price=100.3, idx=1, bar=1), atr=0.4, cp=99.0, ch=99.5, cl=98.4, vol_ratio=1.5, zone="DISCOUNT",
)
# breaker OB narrative + no FVG + no sweep (BOS sentence from sweep_down level)
breaker = analysis(
    trend="RANGING", bull_ob=ob(True, 98.0, 100.0, "bearish_breaker", breaker=True),
    sweep_down=dict(swept=False, level=103.3, direction="DOWN"),
    sh=dict(price=104.0, idx=1, bar=1), atr=0.4, cp=99.0, ch=99.5, cl=98.4, vol_ratio=2.0, zone="DISCOUNT",
    choch=dict(detected=True, price=101.1, direction="UP", bar_ago=2, wick_sweep=False),
)
choch_down = analysis(
    trend="BEARISH", bear_ob=ob(True, 100.0, 102.0, "bearish"), bear_fvg=fvg("bearish", 97.0, 97.5),
    sl=dict(price=95.0, idx=1, bar=1), atr=0.4, cp=101.0, ch=101.6, cl=100.5, vol_ratio=2.0, zone="PREMIUM", pos=80.0,
    choch=dict(detected=True, price=99.9, direction="DOWN", bar_ago=2, wick_sweep=False),
)

CFG_DEFAULT = dict()
CFG_CONS = dict(min_confirmations=4, min_rr=2.5, smc_pd_filter=True, smc_mtf_check=True, smc_retrace_depth=0.5,
                smc_use_volume_filter=True, smc_conf_type="BODY_CLOSE")
CFG_ACTIVE = dict(min_confirmations=2, min_rr=1.5, smc_conf_type="WICK_TOUCH", smc_pd_filter=False, smc_retrace_depth=0.0,
                  smc_mtf_check=False, sweep_close_req=False, ob_max_age=50, smc_vol_mult=1.0)

cases = []


def add(name, an, overrides=None, high_wr=False, kw_over=None, symbol=None):
    c, cfgd, key, kw, ucfg = cfg_from_user(overrides or {}, high_wr)
    if kw_over:
        kw.update(kw_over)
    a = json.loads(json.dumps(an))
    sym = symbol or a["symbol"]
    a["symbol"] = sym
    sig = build_smc_signal(sym, json.loads(json.dumps(a)), c, **kw)
    lv = {d: calculate_levels(json.loads(json.dumps(a)), d, c) for d in ("LONG", "SHORT")}
    sb = score_bullish(a, vol_mult=float(c.VOL_MULT))
    ss = score_bearish(a, vol_mult=float(c.VOL_MULT))
    # inputs stay at full precision (json.dump writes repr(float), which round-trips exactly);
    # only the EXPECTED outputs get the .10g fixture rounding
    cases.append(dict(
        name=name, symbol=sym, analysis=a, user_cfg=overrides or {}, high_wr_mode=high_wr, kwargs=kw,
        expected=r10(dict(
            cfg=cfgd, analysis_key=key, ucfg=ucfg,
            signal=sig_dict(sig, c),
            levels=lv,
            score_long=[sb[0], [[l, bool(v)] for l, v in sb[1]]],
            score_short=[ss[0], [[l, bool(v)] for l, v in ss[1]]],
            retrace={f"{d}@{dep}": _check_retrace_with_depth(a, d, dep) for d in ("LONG", "SHORT") for dep in (0.0, 0.2, 0.5, 0.8)},
            mode_tag=_compute_mode_tag(kw["conf_type"], kw["pd_filter"], kw["retrace_depth"], kw["mtf_check"]),
        )),
    ))


add("rich_long_default", rich_long)
add("rich_long_conservative", rich_long, CFG_CONS, True)
add("rich_long_active", rich_long, CFG_ACTIVE)
add("rich_short_default", rich_short)
add("rich_short_conservative", rich_short, CFG_CONS, True)
add("rich_short_active", rich_short, CFG_ACTIVE)
add("tie_default", tie)
add("tie_short_only", tie, kw_over=dict(allowed_dirs=["SHORT"]))
add("tie_long_only", tie, kw_over=dict(allowed_dirs=["LONG"]))
add("tie_none", tie, kw_over=dict(allowed_dirs=[]))
add("ladder_bad_default", ladder_bad)
add("ladder_rescue_default", ladder_rescue)
add("ladder_rescue_active", ladder_rescue, CFG_ACTIVE)
add("breaker_default", breaker)
add("choch_down_default", choch_down)
# memcoin cap + min stop
add("rich_long_pepe", rich_long, symbol="PEPE-USDT-SWAP")
add("rich_short_btc", rich_short, symbol="BTC-USDT-SWAP")
# wick-sweep guard: BODY_CLOSE blocks, WICK_TOUCH passes
ws = json.loads(json.dumps(rich_long)); ws["structure"]["bos_wick_sweep"] = True
add("wick_sweep_body_close", ws)
add("wick_sweep_wick_touch", ws, CFG_ACTIVE)
# MTF block: BEARISH HTF without CHoCH UP blocks LONG under mtf_check
mtf = json.loads(json.dumps(rich_long)); mtf["structure"]["trend"] = "BEARISH"
add("mtf_block_cons", mtf, CFG_CONS, True)
add("mtf_block_default", mtf)
# P/D block: LONG in PREMIUM under pd_filter
pdp = json.loads(json.dumps(rich_long)); pdp["pd_zone"] = dict(zone="PREMIUM", position_pct=50.0)
add("pd_block_cons", pdp, CFG_CONS, True)
add("pd_block_default", pdp)
# F5 hard volume filter
lowv = json.loads(json.dumps(rich_long)); lowv["vol_ratio"] = 1.1
add("vol_filter_cons", lowv, CFG_CONS, True)
add("vol_filter_default", lowv)
# analysis error
err = json.loads(json.dumps(rich_long)); err["error"] = "boom"
add("analysis_error", err)
# tight stops: alt (<0.4%), major (<0.25%), memcoin (<0.8%)
tight = analysis(trend="BULLISH", bull_ob=ob(True, 99.8, 100.0, "bullish"), bull_fvg=fvg("bullish", 101.0, 101.5),
                 sh=dict(price=104.0, idx=1, bar=1), atr=0.01, cp=99.9, ch=99.95, cl=99.85, vol_ratio=1.5, zone="DISCOUNT")
add("tight_alt", tight)
add("tight_btc", tight, symbol="BTC-USDT-SWAP")
add("tight_doge", tight, symbol="DOGE-USDT-SWAP")
# 0.3 % stop: alt (< 0.4 %) rejected, major (≥ 0.25 %) accepted at the same distance
tight2 = analysis(trend="BULLISH", bull_ob=ob(True, 99.9, 100.0, "bullish"), bull_fvg=fvg("bullish", 101.0, 101.5),
                  sh=dict(price=104.0, idx=1, bar=1), atr=0.01, cp=99.95, ch=99.97, cl=99.92, vol_ratio=1.5, zone="DISCOUNT")
add("tight2_alt", tight2)
add("tight2_eth", tight2, symbol="ETHFI-USDT-SWAP")
# ATR floor: risk < 1.0×ATR
atrf = json.loads(json.dumps(rich_long)); atrf["atr"] = 5.0
add("atr_floor", atrf)
# HWR mode forcing MIN_CONF 4 with min_confirmations=2 and pd/mtf on
add("hwr_active_cfg", rich_long, CFG_ACTIVE, True)
# magnet capped: equal low far below (within 0.5%) but push exceeds 0.6% → capped
cap = json.loads(json.dumps(rich_long)); cap["liquidity"]["equal_lows"] = [dict(price=97.17, count=2, levels=[97.17, 97.17], type="EQL")]
add("magnet_capped", cap)
# small-price symbol for _fp formatting
small = json.loads(json.dumps(rich_long))
def scale(o, f):
    if isinstance(o, dict):
        return {k: (scale(v, f) if k not in ("position_pct", "vol_ratio", "vol_last", "vol_avg", "squeeze_score", "bar_ago", "idx", "bar", "count", "gap_pct", "wick_ratio") else v) for k, v in o.items()}
    if isinstance(o, list):
        return [scale(v, f) for v in o]
    if isinstance(o, float):
        return o * f
    return o
small = scale(small, 0.00006575 / 100.0); small["symbol"] = "SYN-USDT-SWAP"
add("small_price", small)
big = scale(json.loads(json.dumps(rich_long)), 650.0); big["symbol"] = "SYN-USDT-SWAP"
add("big_price", big)

# standalone magnet cases (adjust_sl_for_magnets)
magnets = []
for name, sl, d, prices in [
    ("long_in_zone", 100.0, "LONG", [99.8, 99.6, 99.4]),
    ("long_boundary", 100.0, "LONG", [99.5]),
    ("long_capped", 100.0, "LONG", [99.42]),
    ("long_none", 100.0, "LONG", [99.0, 101.0]),
    ("short_in_zone", 100.0, "SHORT", [100.2, 100.45]),
    ("short_boundary", 100.0, "SHORT", [100.5]),
    ("short_capped", 100.0, "SHORT", [100.58]),
    ("short_none", 100.0, "SHORT", [101.0]),
    ("invalid_sl", 0.0, "LONG", [1.0]),
    ("empty", 100.0, "LONG", []),
    ("zeros", 100.0, "LONG", [0.0, -1.0]),
]:
    new_sl, info = adjust_sl_for_magnets(sl, d, prices)
    magnets.append(dict(name=name, sl=sl, direction=d, prices=prices, new_sl=r10(new_sl), info=r10(info)))
liq_wrap = []
for name, sl, d, liq in [
    ("no_liq", 100.0, "LONG", {}),
    ("none_liq", 100.0, "LONG", None),
    ("invalid_sl", -1.0, "LONG", dict(equal_lows=[dict(price=99.8)])),
    ("long", 100.0, "LONG", dict(equal_lows=[dict(price=99.8), dict(price=99.7)], equal_highs=[dict(price=99.9)])),
    ("short", 100.0, "SHORT", dict(equal_lows=[dict(price=100.1)], equal_highs=[dict(price=100.3), dict(price=100.1)])),
]:
    new_sl, info = _adjust_sl_for_liquidity(sl, d, liq)
    liq_wrap.append(dict(name=name, sl=sl, direction=d, liq=liq, new_sl=r10(new_sl), info=r10(info)))

truthy = [[repr(v), bool(v)] for v in [None, False, True, 0, 0.0, -0.0, 1, 1e-300, float("nan"), "", "a", [], [0], {}, {"a": None}]]

mode_tags = [[ct, pdf, rd, mc, _compute_mode_tag(ct, pdf, rd, mc)]
             for ct in ("BODY_CLOSE", "WICK_TOUCH") for pdf in (False, True) for rd in (0.0, 0.2, 0.5, 1.0) for mc in (False, True)]

out = dict(cases=cases, magnets=magnets, liq_wrap=liq_wrap, truthy=truthy, mode_tags=mode_tags)
json.dump(out, open(sys.argv[1], "w"), ensure_ascii=False, indent=1)
print("cases", len(cases), "signals", sum(1 for c in cases if c["expected"]["signal"]), "magnets", len(magnets))
