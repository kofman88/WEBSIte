"""gen_edge_expected.py — adversarial / edge-case SMC cases produced by the bot's own Python code
(smc/*, squeeze_detector, momentum_detector relax helpers, smc/scanner user-config derivation and
direction filters) for tests/smc/edge.test.js. It covers what the golden sweep cannot see:

  * user-config derivation for every setting incl. relaxed momentum mode, high_wr_mode, the three
    tf_key groups (+ unknown key), direction / smc_long_active / smc_short_active, WICK_TOUCH, P/D,
    MTF check, retrace depths, hard volume filter, vol_mult / vol_len oddities, analysis-key fields;
  * symbol classes (memcoin keywords incl. substring quirks, BTC/ETH majors, lowercase);
  * degenerate frames: HTF < 30 bars / exactly 30, empty / 1 / 2 / 21-bar MTF, LTF=None, NaN volume
    (last bar, inside the window, all), flat candles (zero ATR), zero prices (ZeroDivisionError paths),
    NaN high/low, tiny and huge price scales (narrative `_fp` formatting).

Frames are slices of the golden candle fixtures (tests/golden/candles) at a bar where the default
variant emitted a signal, mutated in place; NaN is encoded as null in edge_frames.json.

Usage (pinned venv, from anywhere; GOLDEN_BOT_DIR defaults to the bot checkout):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 python -I gen_edge_expected.py
Writes edge_frames.json + edge_expected.json next to this file.
"""
import copy
import dataclasses
import json
import math
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "golden"))
sys.path.insert(0, GOLDEN_DIR)

import make_golden as mg          # noqa: E402  (sets BOT_DIR env, pinned env flags, chdir, sys.path)
import numpy as np                # noqa: E402
import pandas as pd               # noqa: E402

from smc.analyzer import SMCAnalyzer, SMCConfig      # noqa: E402
from smc.signal_builder import build_smc_signal, calculate_levels, score_bullish, score_bearish  # noqa: E402
from smc.scanner import _analysis_key, _SMC_TF_MAP, _rr_ladder   # noqa: E402
from user_manager import SMCUserCfg                   # noqa: E402
from squeeze_detector import compute_squeeze_score    # noqa: E402
import momentum_detector as md                        # noqa: E402

TF_MS = mg.TF_MS


# ────────────────────────────────────────────────────────────────────────────
# frames
# ────────────────────────────────────────────────────────────────────────────
def bars_of(df):
    """DataFrame → [[ms, o, h, l, c, v], ...] with NaN → None."""
    out = []
    for ts, row in zip(df.index, df.itertuples(index=False)):
        rec = [int(pd.Timestamp(ts).value // 10**6)]
        for x in row:
            x = float(x)
            rec.append(None if math.isnan(x) else x)
        out.append(rec)
    return out


def df_of(bars):
    if not bars:
        return pd.DataFrame({"open": [], "high": [], "low": [], "close": [], "volume": []},
                            index=pd.DatetimeIndex([], name="open_time"), dtype=float)
    arr = np.array([[b[0]] + [np.nan if x is None else x for x in b[1:]] for b in bars], dtype=float)
    idx = pd.to_datetime(arr[:, 0].astype("int64"), unit="ms")
    df = pd.DataFrame({"open": arr[:, 1], "high": arr[:, 2], "low": arr[:, 3], "close": arr[:, 4], "volume": arr[:, 5]}, index=idx)
    df.index.name = "open_time"
    return df


def first_signal_bar(symbol, variant="default"):
    import gzip
    with gzip.open(os.path.join(GOLDEN_DIR, "expected", "smc.json.gz"), "rt") as fh:
        d = json.load(fh)
    bars = d["fixtures"][symbol][variant]["signal_bars"]
    return bars[0]


def frame_set(symbol, i, mtf_n=150, htf_n=80, ltf_n=150):
    df1h = mg.load_df(GOLDEN_DIR, symbol, "1h")
    df4h = mg.load_df(GOLDEN_DIR, symbol, "4h")
    df15 = mg.load_df(GOLDEN_DIR, symbol, "15m")
    oms = mg.open_ms(df1h)
    close_ms = int(oms[i]) + TF_MS["1h"]
    mtf = df1h.iloc[:i + 1].iloc[-mtf_n:]
    htf = mg.aligned_prefix(df4h, "4h", close_ms, htf_n)
    ltf = mg.aligned_prefix(df15, "15m", close_ms, ltf_n)
    return {"htf": bars_of(htf), "mtf": bars_of(mtf), "ltf": bars_of(ltf)}


def mutate(fs, fn):
    out = copy.deepcopy(fs)
    fn(out)
    return out


def flatten(bars, price=None, vol=None):
    if not bars:
        return bars
    p = bars[-1][4] if price is None else price
    v = bars[-1][5] if vol is None else vol
    for b in bars:
        b[1] = b[2] = b[3] = b[4] = p
        b[5] = v
    return bars


def scale_prices(bars, k):
    for b in bars:
        for j in (1, 2, 3, 4):
            if b[j] is not None:
                b[j] = b[j] * k
    return bars


# ────────────────────────────────────────────────────────────────────────────
# scanner replicas (verbatim semantics of smc/scanner._scan_cycle)
# ────────────────────────────────────────────────────────────────────────────
def set_relaxed(on: bool):
    md._state.relaxed = bool(on)
    md._state.relaxed_until = (time.time() + 3600) if on else 0.0


def scanner_cfg(ucfg, high_wr_mode, relaxed):
    """smc/scanner._scan_cycle user cache: cfg_obj, analysis key, pd/mtf effective flags."""
    set_relaxed(relaxed)
    try:
        eff_conf = md.relax_confirmations(ucfg.min_confirmations)
        eff_rr = md.relax_min_rr(ucfg.min_rr)
    except Exception:
        eff_conf = ucfg.min_confirmations
        eff_rr = ucfg.min_rr
    cfg_obj = SMCConfig()
    cfg_obj.MIN_CONFIRMATIONS = eff_conf
    cfg_obj.MIN_RR = eff_rr
    cfg_obj.SL_BUFFER_PCT = ucfg.sl_buffer_pct
    cfg_obj.FVG_ENABLED = ucfg.fvg_enabled
    cfg_obj.CHOCH_ENABLED = ucfg.choch_enabled
    cfg_obj.OB_USE_BREAKER = ucfg.ob_use_breaker
    cfg_obj.OB_MAX_AGE_CANDLES = ucfg.ob_max_age
    cfg_obj.SWEEP_CLOSE_REQUIRED = ucfg.sweep_close_req
    cfg_obj.VOL_MULT = float(getattr(ucfg, "smc_vol_mult", 1.2) or 1.2)
    cfg_obj.VOL_LEN = int(getattr(ucfg, "smc_vol_len", 20) or 20)
    cfg_obj.USE_VOLUME_FILTER = bool(getattr(ucfg, "smc_use_volume_filter", False))
    an_key = _analysis_key(cfg_obj)
    hwm = high_wr_mode or 0
    if hwm:
        cfg_obj.MIN_CONFIRMATIONS = max(cfg_obj.MIN_CONFIRMATIONS, 4)
        pd_filter_eff, mtf_check_eff = True, True
    else:
        pd_filter_eff = getattr(ucfg, "smc_pd_filter", False)
        mtf_check_eff = getattr(ucfg, "smc_mtf_check", False)
    set_relaxed(False)
    return cfg_obj, an_key, pd_filter_eff, mtf_check_eff


def scanner_dirs(ucfg, smc_long_active, smc_short_active):
    _dirs = ["LONG", "SHORT"]
    if getattr(ucfg, "direction", "BOTH") in ("LONG", "SHORT"):
        _dirs = [ucfg.direction]
    l0 = bool(smc_long_active)
    s0 = bool(smc_short_active)
    if l0 or s0:
        _dirs = [d for d in _dirs if (l0 if d == "LONG" else s0)]
    return _dirs


def scanner_post_direction_ok(sig, ucfg, smc_long_active, smc_short_active):
    """§6.5 direction + toggle re-check after the signal is built."""
    if ucfg.direction != "BOTH" and sig.direction != ucfg.direction:
        return False
    l = bool(smc_long_active)
    s = bool(smc_short_active)
    if (l or s) and not (l if sig.direction == "LONG" else s):
        return False
    return True


def tf_group(tf_key):
    if tf_key not in _SMC_TF_MAP:
        tf_key = "1H"
    return list(_SMC_TF_MAP[tf_key])


def vol_gate_passes(ucfg, coin_vol):
    """§6.2 per-user volume gate (True = scanned)."""
    _user_min_vol = float(getattr(ucfg, "min_volume_usdt", 5_000_000) or 0)
    _coin_vol = float(coin_vol or 0)
    return not (_user_min_vol > 0 and _coin_vol < _user_min_vol)


# ────────────────────────────────────────────────────────────────────────────
# case runner
# ────────────────────────────────────────────────────────────────────────────
_ANALYZERS = {}


def analyzer_for(key):
    an = _ANALYZERS.get(key)
    if an is None:
        an = SMCAnalyzer(SMCConfig(FVG_ENABLED=key[0], CHOCH_ENABLED=key[1], OB_USE_BREAKER=key[2],
                                   OB_MAX_AGE_CANDLES=key[3], SWEEP_CLOSE_REQUIRED=key[4], VOL_LEN=key[5]))
        _ANALYZERS[key] = an
    return an


def exc_str(e):
    return f"{type(e).__name__}: {e}"


def run_case(c, frames):
    fs = frames[c["frames"]]
    symbol = c.get("symbol") or c["frames_symbol"]
    ucfg = SMCUserCfg(**c.get("user_cfg", {}))
    hwm, relaxed = c.get("high_wr_mode", False), c.get("relaxed", False)
    l0, s0 = c.get("smc_long_active", False), c.get("smc_short_active", False)
    cfg_obj, an_key, pd_eff, mtf_eff = scanner_cfg(ucfg, hwm, relaxed)
    tf_htf, tf_mtf, tf_ltf = tf_group(ucfg.tf_key)
    dirs = scanner_dirs(ucfg, l0, s0)
    bk = dict(tf_htf=tf_htf, tf_mtf=tf_mtf, tf_ltf=tf_ltf, allowed_dirs=tuple(dirs),
              conf_type=getattr(ucfg, "smc_conf_type", "WICK_TOUCH"), pd_filter=pd_eff,
              retrace_depth=getattr(ucfg, "smc_retrace_depth", 0.0), mtf_check=mtf_eff)

    df_htf, df_mtf = df_of(fs["htf"]), df_of(fs["mtf"])
    df_ltf = None if c.get("ltf_none") else df_of(fs["ltf"])

    analysis = analyzer_for(an_key).analyze(symbol, df_htf, df_mtf, df_ltf)
    try:
        analysis["squeeze_score"] = compute_squeeze_score(df_mtf)
    except Exception:
        analysis["squeeze_score"] = 0

    rec = dict(
        name=c["name"], frames=c["frames"], symbol=symbol, user_cfg=dataclasses.asdict(ucfg),
        high_wr_mode=bool(hwm), relaxed=bool(relaxed), smc_long_active=bool(l0), smc_short_active=bool(s0),
        ltf_none=bool(c.get("ltf_none", False)),
        derived=dict(cfg=mg.r10(mg._smc_cfg_dict(cfg_obj)), analysis_key=list(an_key), pd_filter=pd_eff, mtf_check=mtf_eff,
                     dirs=dirs, skip_user=(not dirs), build_kwargs={k: (list(v) if isinstance(v, tuple) else v) for k, v in bk.items()}),
        digest=mg._smc_digest(analysis),
        squeeze_score=int(analysis.get("squeeze_score", 0) or 0),
        analysis_error=analysis.get("error"),
        scores={}, levels={}, signal=None, build_exception=None, post_direction_ok=None, rr_ladder=None, passes_ctx_gate=None,
    )
    vm = float(getattr(cfg_obj, "VOL_MULT", 1.2) or 1.2)
    for d, fn in (("LONG", score_bullish), ("SHORT", score_bearish)):
        try:
            sc, conf = fn(analysis, vol_mult=vm)
            rec["scores"][d] = [sc, [[lbl, bool(ok)] for lbl, ok in conf]]
        except Exception as e:   # noqa: BLE001
            rec["scores"][d] = exc_str(e)
        try:
            lv = calculate_levels(analysis, d, cfg_obj)
            rec["levels"][d] = mg.r10(lv) if lv is not None else None
        except Exception as e:   # noqa: BLE001
            rec["levels"][d] = exc_str(e)
    if dirs:
        try:
            sig = build_smc_signal(symbol, analysis, cfg_obj, **bk)
        except Exception as e:   # noqa: BLE001
            sig = None
            rec["build_exception"] = exc_str(e)
            rec["build_traceback_tail"] = traceback.format_exc().strip().splitlines()[-3:]
        if sig is not None:
            d = dataclasses.asdict(sig)
            d["confirmations"] = [[lbl, bool(ok)] for lbl, ok in d["confirmations"]]
            rec["signal"] = mg.r10(d)
            rec["post_direction_ok"] = scanner_post_direction_ok(sig, ucfg, l0, s0)
            rec["rr_ladder"] = list(_rr_ladder(sig))
            rec["passes_ctx_gate"] = bool(int(getattr(sig, "score", 0) or 0) >= int(getattr(cfg_obj, "MIN_CONFIRMATIONS", 0) or 0))
    return rec


# ────────────────────────────────────────────────────────────────────────────
# fixture definition
# ────────────────────────────────────────────────────────────────────────────
def build_frames():
    F = {}
    base = {
        "btc": ("BTC-USDT-SWAP", 274),
        "doge": ("DOGEVL08-USDT-SWAP", 204),
        "eth": ("ETH-USDT-SWAP", 263),
        "synrg": ("SYNRG01-USDT-SWAP", first_signal_bar("SYNRG01-USDT-SWAP")),
        "pepe": ("PEPEVL07-USDT-SWAP", first_signal_bar("PEPEVL07-USDT-SWAP")),
        "synlv": ("SYNLV04-USDT-SWAP", first_signal_bar("SYNLV04-USDT-SWAP")),
    }
    sym = {}
    for k, (s, i) in base.items():
        F[k] = frame_set(s, i)
        sym[k] = s
    btc = F["btc"]

    def mk(name, fn, src="btc"):
        F[name] = mutate(F[src], fn)
        sym[name] = sym[src]

    mk("htf29", lambda f: f.__setitem__("htf", f["htf"][-29:]))
    mk("htf30", lambda f: f.__setitem__("htf", f["htf"][-30:]))
    mk("htf31", lambda f: f.__setitem__("htf", f["htf"][-31:]))
    mk("mtf_empty", lambda f: f.__setitem__("mtf", []))
    mk("mtf_1", lambda f: f.__setitem__("mtf", f["mtf"][-1:]))
    mk("mtf_2", lambda f: f.__setitem__("mtf", f["mtf"][-2:]))
    mk("mtf_21", lambda f: f.__setitem__("mtf", f["mtf"][-21:]))
    mk("mtf_22", lambda f: f.__setitem__("mtf", f["mtf"][-22:]))
    mk("mtf_71", lambda f: f.__setitem__("mtf", f["mtf"][-71:]))
    mk("ltf_empty", lambda f: f.__setitem__("ltf", []))
    mk("ltf_2", lambda f: f.__setitem__("ltf", f["ltf"][-2:]))
    mk("nan_vol_last", lambda f: f["mtf"][-1].__setitem__(5, None))
    mk("nan_vol_win", lambda f: (f["mtf"][-5].__setitem__(5, None), f["mtf"][-10].__setitem__(5, None)))
    mk("nan_vol_all", lambda f: [b.__setitem__(5, None) for b in f["mtf"]])
    mk("zero_vol_all", lambda f: [b.__setitem__(5, 0.0) for b in f["mtf"]])
    mk("flat_mtf", lambda f: flatten(f["mtf"]))
    mk("flat_tail", lambda f: flatten(f["mtf"][-25:]))
    mk("flat_all", lambda f: (flatten(f["htf"], f["mtf"][-1][4]), flatten(f["mtf"]), flatten(f["ltf"], f["mtf"][-1][4])))
    mk("zero_low_htf", lambda f: (f["htf"][20].__setitem__(3, 0.0), f["htf"][45].__setitem__(3, 0.0)))
    mk("zero_low_htf_one", lambda f: f["htf"][45].__setitem__(3, 0.0))
    mk("zero_high_ltf", lambda f: f["ltf"][60].__setitem__(2, 0.0))
    mk("nan_mtf_last_hl", lambda f: (f["mtf"][-1].__setitem__(2, None), f["mtf"][-1].__setitem__(3, None)))
    mk("nan_mtf_last_close", lambda f: f["mtf"][-1].__setitem__(4, None))
    mk("nan_htf_mid", lambda f: (f["htf"][40].__setitem__(2, None), f["htf"][40].__setitem__(3, None)))
    mk("nan_ltf_some", lambda f: (f["ltf"][100].__setitem__(2, None), f["ltf"][101].__setitem__(3, None)))
    mk("tiny", lambda f: [scale_prices(f[k], 1e-6) for k in ("htf", "mtf", "ltf")])
    mk("huge", lambda f: [scale_prices(f[k], 1000.0) for k in ("htf", "mtf", "ltf")])
    mk("huge_doge", lambda f: [scale_prices(f[k], 1e6) for k in ("htf", "mtf", "ltf")], "doge")
    mk("tiny_eth", lambda f: [scale_prices(f[k], 1e-7) for k in ("htf", "mtf", "ltf")], "eth")
    # OB candle high = 0 → _find_impulse_fvg ZeroDivisionError (bull OB index from the clean analysis)
    an = SMCAnalyzer(SMCConfig(OB_MAX_AGE_CANDLES=80, SWEEP_CLOSE_REQUIRED=True)).analyze("BTC-USDT-SWAP", df_of(btc["htf"]), df_of(btc["mtf"]), df_of(btc["ltf"]))
    bo = an["ob"]["bull_ob"]
    if bo.get("bar_ago") is not None and bo.get("type") == "bullish":
        idx = len(btc["mtf"]) - 1 - int(bo["bar_ago"])
        mk("zero_high_ob", lambda f: f["mtf"][idx].__setitem__(2, 0.0))
    return F, sym


def build_cases(sym):
    C = []

    def add(name, frames, **kw):
        kw.setdefault("frames_symbol", sym[frames])
        C.append(dict(name=name, frames=frames, **kw))

    # every frame set with the default config (symbol = the frame's own symbol)
    for fkey in sym:
        add(f"{fkey}_default", fkey)

    # ── config space on the clean BTC frames ──
    U = lambda **o: dict(user_cfg=o)   # noqa: E731
    add("btc_tf15m", "btc", **U(tf_key="15m"))
    add("btc_tf4H", "btc", **U(tf_key="4H"))
    add("btc_tf_unknown", "btc", **U(tf_key="5m"))
    add("btc_tf_proto", "btc", **U(tf_key="constructor"))
    add("btc_hwr", "btc", high_wr_mode=True)
    add("btc_hwr_minconf2", "btc", high_wr_mode=True, **U(min_confirmations=2))
    add("btc_hwr_minconf5", "btc", high_wr_mode=True, **U(min_confirmations=5))
    add("btc_relaxed", "btc", relaxed=True)
    add("btc_relaxed_minconf2", "btc", relaxed=True, **U(min_confirmations=2))
    add("btc_relaxed_minconf5_rr3", "btc", relaxed=True, **U(min_confirmations=5, min_rr=3.0))
    add("btc_relaxed_rr15", "btc", relaxed=True, **U(min_rr=1.5))
    add("btc_relaxed_hwr", "btc", relaxed=True, high_wr_mode=True)
    add("btc_dir_long", "btc", **U(direction="LONG"))
    add("btc_dir_short", "btc", **U(direction="SHORT"))
    add("btc_dir_lower", "btc", **U(direction="long"))
    add("btc_flag_long", "btc", smc_long_active=True)
    add("btc_flag_short", "btc", smc_short_active=True)
    add("btc_flag_both", "btc", smc_long_active=True, smc_short_active=True)
    add("btc_dir_long_flag_short", "btc", smc_short_active=True, **U(direction="LONG"))
    add("btc_dir_short_flag_long", "btc", smc_long_active=True, **U(direction="SHORT"))
    add("btc_wick_touch", "btc", **U(smc_conf_type="WICK_TOUCH"))
    add("btc_pd_on", "btc", **U(smc_pd_filter=True))
    add("btc_mtf_on", "btc", **U(smc_mtf_check=True))
    add("btc_pd_mtf_wick", "btc", **U(smc_pd_filter=True, smc_mtf_check=True, smc_conf_type="WICK_TOUCH"))
    add("btc_retrace0", "btc", **U(smc_retrace_depth=0.0))
    add("btc_retrace03", "btc", **U(smc_retrace_depth=0.3))
    add("btc_retrace05", "btc", **U(smc_retrace_depth=0.5))
    add("btc_retrace1", "btc", **U(smc_retrace_depth=1.0))
    add("btc_retrace_int1", "btc", **U(smc_retrace_depth=1))
    add("btc_volfilter_low", "btc", **U(smc_use_volume_filter=True, smc_vol_mult=0.5))
    add("btc_volfilter_high", "btc", **U(smc_use_volume_filter=True, smc_vol_mult=5.0))
    add("btc_volmult_int", "btc", **U(smc_vol_mult=2))
    add("btc_volmult_zero", "btc", **U(smc_vol_mult=0))
    add("btc_vollen3", "btc", **U(smc_vol_len=3))
    add("btc_vollen0", "btc", **U(smc_vol_len=0))
    add("btc_vollen_float", "btc", **U(smc_vol_len=7.9))
    add("btc_vollen_big", "btc", **U(smc_vol_len=140))
    add("btc_vollen_toobig", "btc", **U(smc_vol_len=149))
    add("btc_minconf2_rr15", "btc", **U(min_confirmations=2, min_rr=1.5))
    add("btc_minconf5", "btc", **U(min_confirmations=5))
    add("btc_minconf_float", "btc", **U(min_confirmations=2.5))
    add("btc_rr3", "btc", **U(min_rr=3.0))
    add("btc_sl01", "btc", **U(sl_buffer_pct=0.1))
    add("btc_sl05", "btc", **U(sl_buffer_pct=0.5))
    add("btc_sl0", "btc", **U(sl_buffer_pct=0.0))
    add("btc_sl_big", "btc", **U(sl_buffer_pct=5.0))
    add("btc_obage20", "btc", **U(ob_max_age=20))
    add("btc_obage100", "btc", **U(ob_max_age=100))
    add("btc_obage_float", "btc", **U(ob_max_age=50.7))
    add("btc_fvg_off", "btc", **U(fvg_enabled=False))
    add("btc_choch_off", "btc", **U(choch_enabled=False))
    add("btc_breaker_off", "btc", **U(ob_use_breaker=False))
    add("btc_sweep_off", "btc", **U(sweep_close_req=False))
    add("btc_key_all_off", "btc", **U(fvg_enabled=False, choch_enabled=False, ob_use_breaker=False, ob_max_age=20, sweep_close_req=False, smc_vol_len=5))
    add("btc_active_like", "btc", **U(min_confirmations=2, min_rr=1.5, smc_conf_type="WICK_TOUCH", smc_retrace_depth=0.0, sl_buffer_pct=0.25))
    add("btc_ltf_none", "btc", ltf_none=True)
    add("btc_ltf_none_fvg_off", "btc", ltf_none=True, **U(fvg_enabled=False))
    # symbol classes on the BTC frames
    for s in ("PEPE-USDT-SWAP", "ETHFI-USDT-SWAP", "1000SATS-USDT-SWAP", "ACTA-USDT-SWAP", "MEMEFI-USDT-SWAP",
              "pepe-usdt-swap", "ETHMEME-USDT-SWAP", "SOL-USDT-SWAP", "BOOKOFMEME-USDT-SWAP", "FACTORY-USDT-SWAP", ""):
        add(f"btc_sym_{s or 'empty'}", "btc", symbol=s, **U(min_confirmations=2, min_rr=1.5))
    # other frame sets with a few configs
    add("doge_hwr", "doge", high_wr_mode=True)
    add("doge_active_like", "doge", **U(min_confirmations=2, min_rr=1.5, smc_conf_type="WICK_TOUCH", smc_retrace_depth=0.0))
    add("doge_as_alt", "doge", symbol="SYN-USDT-SWAP", **U(min_confirmations=2, min_rr=1.5))
    add("pepe_tf15m_wick", "pepe", **U(tf_key="15m", smc_conf_type="WICK_TOUCH", min_confirmations=2, min_rr=1.5))
    add("eth_tf4H", "eth", **U(tf_key="4H"))
    add("eth_dir_short", "eth", **U(direction="SHORT", min_confirmations=2, min_rr=1.5))
    add("synrg_active_like", "synrg", **U(min_confirmations=2, min_rr=1.5, smc_conf_type="WICK_TOUCH", smc_retrace_depth=0.0))
    add("synlv_volfilter", "synlv", **U(smc_use_volume_filter=True, smc_vol_mult=1.0, min_confirmations=2, min_rr=1.5))
    # degenerate frames with permissive configs so the builder path is exercised
    for fkey in ("htf29", "htf30", "mtf_1", "mtf_2", "mtf_21", "mtf_22", "nan_vol_last", "nan_vol_win", "nan_vol_all", "zero_vol_all",
                 "flat_tail", "nan_mtf_last_hl", "nan_mtf_last_close", "nan_htf_mid", "nan_ltf_some", "tiny", "huge", "ltf_2"):
        add(f"{fkey}_wick2", fkey, **U(min_confirmations=2, min_rr=1.5, smc_conf_type="WICK_TOUCH", smc_retrace_depth=0.0))
    add("nan_vol_last_volfilter", "nan_vol_last", **U(smc_use_volume_filter=True, min_confirmations=2, min_rr=1.5, smc_conf_type="WICK_TOUCH", smc_retrace_depth=0.0))
    add("flat_tail_retrace05", "flat_tail", **U(smc_retrace_depth=0.5, min_confirmations=2, min_rr=1.5, smc_conf_type="WICK_TOUCH"))
    return C


def main():
    frames, sym = build_frames()
    cases = build_cases(sym)
    out_cases = [run_case(c, frames) for c in cases]
    ucfg_d = SMCUserCfg()
    vol_gate = []
    for mv, cv in ((300000, 299999.9), (300000, 300000), (0, 0), (0, 5), (-1, 0), (1e9, None), (300000, None), (5_000_000, 4_999_999)):
        u = SMCUserCfg(min_volume_usdt=mv)
        vol_gate.append([mv, cv, vol_gate_passes(u, cv)])
    tfmap = {k: list(v) for k, v in _SMC_TF_MAP.items()}
    # signal_builder._fp around every power of ten (log10 → decimals) + a few magnitudes
    from smc.signal_builder import _fp
    fp_table = []
    for k in range(1, 13):
        p = 10.0 ** -k
        for v in (p, math.nextafter(p, 0), math.nextafter(p, 1), p * 0.999999999, p * 1.000000001, p * 5.5):
            fp_table.append([repr(v), _fp(v)])
    for v in (0.0009999999999999998, 1.0, 0.99999999999, 99.99999, 100.0, 9999.5, 10000.0, 123456.789, 1e-30, 2.5e-15, 1e300):
        fp_table.append([repr(v), _fp(v)])
    relax_table = []
    for x in (2, 3, 4, 5, 1, 2.5, 3.0):
        set_relaxed(True)
        relax_table.append([x, md.relax_confirmations(x), md.relax_min_rr(float(x) / 2 + 0.5)])
        set_relaxed(False)
    expected = dict(
        note="generated by gen_edge_expected.py with the pinned venv; floats are r10 (float(f'{x:.10g}')), NaN/inf → null",
        python=sys.version.split()[0], pandas=pd.__version__, numpy=np.__version__,
        tf_map=tfmap, defaults=dataclasses.asdict(ucfg_d), vol_gate=vol_gate, fp_table=fp_table,
        relax_table=dict(note="[x, relax_confirmations(x), relax_min_rr(x/2+0.5)] with relaxed mode ON", rows=relax_table),
        cases=out_cases,
    )
    with open(os.path.join(HERE, "edge_frames.json"), "w") as fh:
        json.dump(dict(symbols=sym, frames=frames), fh, separators=(",", ":"))
    with open(os.path.join(HERE, "edge_expected.json"), "w") as fh:
        json.dump(expected, fh, ensure_ascii=False, indent=1)
    n_sig = sum(1 for c in out_cases if c["signal"])
    n_err = sum(1 for c in out_cases if c["analysis_error"])
    n_exc = sum(1 for c in out_cases if c["build_exception"])
    print(f"cases={len(out_cases)} signals={n_sig} analysis_errors={n_err} build_exceptions={n_exc}")
    for c in out_cases:
        flag = "SIG" if c["signal"] else ("ERR" if c["analysis_error"] else ("EXC" if c["build_exception"] else "---"))
        extra = c["analysis_error"] or c["build_exception"] or (c["signal"] and f"{c['signal']['direction']} {c['signal']['score']} {c['signal']['grade']}") or ""
        print(f"  {flag} {c['name']:32s} {extra}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
