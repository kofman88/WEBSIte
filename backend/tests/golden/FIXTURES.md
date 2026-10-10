# Golden test fixtures — CHM_BREAKER_V4 strategies (LEVELS / SMC / VOLUME)

Deterministic, network-free fixtures for a one-to-one JavaScript port of the three pure analysis
functions of the Python bot. Nothing here touches Telegram, the DB or the signal registry: the
generator calls the analysis functions exactly the way the live scanners call them and records what
they return, bar by bar.

```
golden/
├── make_golden.py            generator (self-contained, re-runnable, see "Re-running")
├── summary.json              counts per strategy / variant / fixture, sha256 of expected files, notes
├── README.md                 this file
├── candles/
│   ├── index.json            fixture metadata: regime, seed, beta to BTC, price scale, leg annotations
│   └── <SYMBOL>_<tf>.json    tf ∈ 15m, 1h, 4h, 1d   (42 symbols × 4 = 168 files)
└── expected/
    ├── levels.json           indicator.CHMIndicator.analyze()           per bar, 3 variants
    ├── smc.json              smc.analyzer.SMCAnalyzer.analyze() + smc.signal_builder.build_smc_signal()
    ├── smc_analysis.json     per-bar digest of the SMC analysis dict (default analysis key) — to localise a divergence
    └── volume.json           volume_strategy.analyze_volume()           per bar, 3 variants
```

Versions used: python 3.11.17 (the production interpreter, see "Re-running"), pandas 2.3.3, numpy 1.26.4,
scipy 1.17.1. Elapsed for the full run: 2880.7 s with `--workers 2` on 4 shared cores. The candle files are
seeded and came out byte-identical to the earlier 3.12.3 run; every expected value too (only `python` changed).

## Re-running

```bash
cd /home/user/MAIN_BOT/CHM_BREAKER_V4            # the script chdir()s there itself; cwd is only needed because
BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \         # config.py reads these two env vars at import time
  /path/to/venv/bin/python /path/to/golden/make_golden.py --workers 4 --step 1 --check
```

The venv must be CPython 3.11 with the bot's pinned requirements — the interpreter production runs
(deploy.sh virtualenv `…/3.11`, Dockerfile `python:3.11-slim`). 3.12 is not interchangeable: its builtin
`sum()` over floats is Neumaier-compensated (3.11 adds left to right) and it ships unicodedata 15.0.0
(3.11: 14.0.0). `golden.test.js` asserts `python` 3.11.x in `summary.json` and every expected file.

* `GOLDEN_BOT_DIR` (default `/home/user/MAIN_BOT/CHM_BREAKER_V4`) and `GOLDEN_OUT_DIR` (default: the
  script's directory) override the paths.
* `--step k` sweeps every k-th bar (the shipped files use `--step 1`, i.e. every bar).
  `--fixtures N`, `--symbols PREFIX,...`, `--only levels,smc` are debugging aids.
* `--check` re-runs 3 fixtures after the main pass and asserts byte-identical output
  (`summary.json → determinism_check`).
* `--only volume --keep-others` (bot batch D, c56653d) regenerates `expected/volume.json` alone and merges its
  counts / sha256 into the existing `summary.json` (`partial_regen` records the run); the LEVELS / SMC files are
  kept byte for byte (batch D does not touch indicator.py / smc/*). VOLUME at c56653d: 162 / 151 / 197 →
  109 / 107 / 137 signals ([VOL-MIN-VOLUME]: ribbon / bounce / golden need volume ≥ ×1.5; the 1h sweep never
  hits the 15m [VOL-MIN-SL] stop floor — `make_volume_probe.py` covers 15m). The batch-D VOLUME env vars
  (`VOLUME_MIN_SL_PCT_15M`, `VOLUME_MIN_SETUP_VOL_MULT`, `VOLUME_15M_COINS_FLOOR_USDT`, `VOLUME_POST_SL_PAUSE_BARS`)
  are unset by the generator (their defaults) and recorded as `volume_env` in `expected/volume.json`.
* The script pins every env flag the strategies read (`LEVELS_REGIME_GATE=enforce`, `SL_V2_*=0`,
  `LEVELS_RELAX_ENABLED=0`, squeeze thresholds, …) to the production defaults from `config.py` /
  `sl_v2.py` / `squeeze_detector.py` so the shell cannot influence a re-run; the values are recorded
  under `env` in every expected file and in `summary.json`.
* The bot writes `signal_registry.json` into its cwd when the registry is touched; the generator never
  touches it but deletes the file afterwards if it appeared.

Every number in the expected files is derived only from the candle JSON (the strategies are run on
DataFrames *loaded from the JSON files*, not on the in-memory generator arrays), so a port that reads
the same JSON sees bit-identical inputs.

## Candle fixtures

Format: `{"symbol": "...", "tf": "1h", "bars": [[open_time_ms, open, high, low, close, volume], ...]}`.
`open_time_ms` is aligned to the TF; all series of a symbol end at the same instant
(`2026-01-01T00:00:00Z`): the last 15m, 1h, 4h and 1d bars all close exactly then. Volume is quote
volume (USDT), as the bot's fetcher uses OKX `volCcyQuote`.

* 42 symbols: `BTC-USDT-SWAP`, `ETH-USDT-SWAP` (mixed "market" regime; ETH has beta 0.9 to BTC) and
  8 per regime for `trending_up` (SYNUP01-08), `trending_down` (SYNDN), `ranging` (SYNRG),
  `volatile` (SYNVL01-06 + `PEPEVL07`, `DOGEVL08` — mem-coin names to exercise the mem-coin
  branches), `low_volume` (SYNLV). Price scales 0.00012 … 65 000 (the LEVELS "psychological level"
  rule depends on the absolute price), beta to BTC ∈ {0, 0.4, 0.8} (correlation labels), low-volume
  fixtures have 0.25× volume and beta 0.
* Each symbol is one 400-day path simulated at 15m resolution (4 sub-steps per bar for realistic
  highs/lows) and resampled (`label=left, closed=left`) to 1h / 4h / 1d, so the TFs are mutually
  consistent. Stored: 400 bars of 1h, 4h, 1d and **2000 bars of 15m** (the 15m series must cover the
  whole 1h sweep window plus a 300-bar LTF window for SMC).
* The price path is a sequence of *legs* (impulse → V-reversal → consolidation, pullbacks, retests of
  broken levels, range legs, and "quiet liquidity-sweep" legs — see `_legs()` in the generator) with a
  fast OU noise, volatility clustering, volume seasonality/spikes, and the named regime governing the
  last 30 days (earlier history is a seeded mix of regimes). `candles/index.json →
  fixtures[].legs_last_1h_window` lists the leg boundaries inside the 400-bar 1h window (index = 1h
  bar), i.e. where the "obvious setups" are.
* DataFrame convention used when loading a fixture (identical to `fetcher.py`): columns
  `open/high/low/close/volume` as float64, `DatetimeIndex` named `open_time`, naive UTC
  (`pd.to_datetime(ms, unit="ms")`), last row = last CLOSED bar.

## Sweep protocol (all three strategies)

The sweep runs on the **1h** series (the default timeframe of all three strategies). For every index
`i` from `200` (warm-up: `analyze()` needs ≥ `max(EMA_SLOW, 100) = 200` bars) to `399`:

* primary frame `df = df_1h.iloc[:i+1]` (grows from 201 to 400 bars — the prefix rule requested);
* `close_ms = open_time_ms[i] + 3_600_000`; every auxiliary frame contains the bars of its series that
  are *closed* at `close_ms` (`open_time + tf <= close_ms`), restricted to the last `W` bars:

| strategy | auxiliary frames |
|---|---|
| LEVELS | `df_htf` = 1d, W=300 (only when `use_htf`, i.e. the conservative/active variants; `None` for default — scanner_mid passes `None` when `cfg.use_htf` is false); `df_btc`, `df_eth` = BTC/ETH 1h `iloc[:i+1]` (same index as `df`) |
| SMC | `df_htf` = 4h, W=300; `df_mtf` = `df`; `df_ltf` = 15m, W=300 (tf map `"1H" → ("4H","1H","15m")`) |
| VOLUME | `df_htf` = 4h, W=300 (`HTF_MAP["1h"] = "4h"`), `None` when `use_htf` is false |

W = 300 is what the live WS candle cache / REST default (`limit=300`) delivers.

Expected-file shape (same for the three files; `signals` only lists bars where a signal object was
returned — any swept bar not in `signal_bars` returned `None`):

```jsonc
{
  "strategy": "levels", "python": "...", "pandas": "...", "numpy": "...", "scipy": "...",
  "env": {...pinned flags...}, "sweep": {"tf": "1h", "warmup_index": 200, "step": 1, "rule": "..."},
  "call": "...exact call...", "signal_fields": "...",
  "variants": { "default": {...full config used...}, "conservative": {...}, "active": {...} },
  "fixtures": {
    "SYNLV02-USDT-SWAP": {
      "default": {
        "swept": [200, 399], "step": 1, "n_swept": 200, "n_signals": 8,
        "signal_bars": [204, 238, ...],
        "signals": [ { "i": 204, "ts": "2025-12-23 18:00:00", "open_time_ms": 1766512800000, "n_bars": 205,
                       "direction": "LONG", "entry": ..., "sl": ..., "tp1": ..., "tp2": ..., "tp3": ..., ... } ],
        "reject_reasons": {"200": "zones", "201": "volume", ...},   // LEVELS only
        "errors": [ {"i": ..., "ts": ..., "error": "..."} ],         // exceptions / analysis.error / [VOLUME-ERR]
        "warnings": {"i": ["logger: message", ...]}                   // WARNING-level log records emitted during the call
      }, "conservative": {...}, "active": {...}
    }, ...
  }
}
```

Floats are rounded to 10 significant digits (`float(f"{x:.10g}")`); NaN/inf → `null`. Russian
strings (`reasons`, `human_explanation`, `narrative`, `confirmations` labels, `breakout_type`,
`session`, `trend_local`, `signal_type`, …) are kept verbatim — they are part of the signal objects.

## LEVELS — `indicator.CHMIndicator.analyze`

Call (per bar, exactly as `scanner_mid._run_job` → `ind.analyze(sym, df, df_htf, btc_df, eth_df)`):

```python
from scanner_mid import _cfg_to_ind          # IndConfig built from TradeCfg exactly like the scanner
from user_manager import TradeCfg
from indicator import CHMIndicator
ic  = _cfg_to_ind(TradeCfg(**trade_cfg_overrides), high_wr_mode=high_wr_mode)
ind = CHMIndicator(ic)                       # FRESH instance per bar (see "Non-determinism")
sig = ind.analyze(symbol, df, df_htf, df_btc, df_eth)   # → indicator.SignalResult | None
```

`_cfg_to_ind` maps `TradeCfg` → `IndConfig` 1:1 and applies `MIN_RR = max(cfg.min_rr,
Config.LEVELS_MIN_RR=1.8)`. The scanner builds `TradeCfg` from the user's shared/long/short cfg
(`UserSettings.get_cfg*`); the default user has every field at the `TradeCfg` dataclass default
(`timeframe=1h, pivot_strength=7, atr_period=14, ema_fast=50, ema_slow=200, rsi 14/65/35,
vol_mult=1.0, vol_len=20, zone_buffer=0.3, zone_pct=0.7, max_dist_pct=1.5, min_rr=2.0,
max_level_tests=4, tp1/2/3_rr=2/3/4.5, max_risk_pct=1.5, use_rsi=use_volume=True,
use_pattern=use_htf=False, cooldown_bars=5, min_quality=3`). The full `trade_cfg` and the resulting
`ind_config` of every variant are stored under `variants` in `expected/levels.json`.

Variants (`profiles.py` only changes the scanner-side `min_quality`: 7 conservative / 5 active; the
indicator config is the same for every profile — the extra `TradeCfg` tweaks below are ours, to cover
`use_htf` (1D zone confluence) and `HIGH_WR_MODE`):

| variant | TradeCfg overrides | high_wr_mode | scanner min_quality |
|---|---|---|---|
| default | — | False | 3 |
| conservative | `use_htf=True, vol_mult=1.2, rsi_ob=60, rsi_os=40, min_quality=7` | True | 7 |
| active | `use_htf=True, vol_mult=0.8, zone_pct=1.0, max_dist_pct=2.0, min_rr=1.5 (→ MIN_RR 1.8), cooldown_bars=3, min_quality=5` | False | 5 |

Recorded per signal: every `SignalResult` field (`symbol, direction, entry, sl, tp1, tp2, tp3,
risk_pct, quality, reasons, rsi, volume_ratio, trend_local, trend_htf, pattern, breakout_type,
is_counter_trend, human_explanation, level_class, test_count, rr_score, corr_label, session,
btc_corr, eth_corr, tp1_close_pct, tp2_close_pct, tp3_close_pct, move_sl_to_be_after_tp1`) plus
`i, ts, open_time_ms, n_bars, n_htf_bars`, and two scanner-side pure post-steps:
`squeeze_score = squeeze_detector.compute_squeeze_score(df)` with
`quality_after_squeeze = min(quality+1, 10) if squeeze_score >= 1 else quality` (scanner_mid
"SQUEEZE-BOOST"), and `passes_min_quality = quality_after_squeeze >= variant.min_quality`.
Note `btc_corr`/`eth_corr` in the dataclass stay 0.0 — the scanner fills them later with
`_compute_correlation`; the correlation used *inside* analyze is `corr_label`.

`reject_reasons[i]` is the `indicator._ANALYZE_STATS` bucket incremented by `_none_stat()` for a
`None` result: `zones` (no zones / nearest level farther than MAX_DIST_PCT / signal level too far),
`volume` (vol_ratio < VOL_MULT·0.7), `signal` (no setup, bad approach quality, too many tests),
`rsi`, `sl_risk`, `rr`, `checklist`, `quality_hwr` (HIGH_WR_MODE filters), `levels_filter`
(`levels_filters.evaluate` → `market_regime.detect_regime(df, tf="1h")` is trending; the gate is
ON by default because `Config.LEVELS_REGIME_GATE` defaults to `"enforce"`).

## SMC — `smc.analyzer.SMCAnalyzer.analyze` + `smc.signal_builder.build_smc_signal`

Call (exactly as `smc/scanner._scan_cycle`, momentum relaxed mode off):

```python
from user_manager import SMCUserCfg
from smc.analyzer import SMCAnalyzer, SMCConfig
from smc.scanner import _analysis_key
from smc.signal_builder import build_smc_signal
from squeeze_detector import compute_squeeze_score

ucfg = SMCUserCfg(**user_cfg_overrides)                       # per-user cfg (JSON in UserSettings.smc_cfg)
cfg_obj = SMCConfig()                                          # scanner copies these user fields onto it:
cfg_obj.MIN_CONFIRMATIONS = ucfg.min_confirmations;  cfg_obj.MIN_RR = ucfg.min_rr
cfg_obj.SL_BUFFER_PCT = ucfg.sl_buffer_pct;          cfg_obj.FVG_ENABLED = ucfg.fvg_enabled
cfg_obj.CHOCH_ENABLED = ucfg.choch_enabled;          cfg_obj.OB_USE_BREAKER = ucfg.ob_use_breaker
cfg_obj.OB_MAX_AGE_CANDLES = ucfg.ob_max_age;        cfg_obj.SWEEP_CLOSE_REQUIRED = ucfg.sweep_close_req
cfg_obj.VOL_MULT = ucfg.smc_vol_mult;                cfg_obj.VOL_LEN = ucfg.smc_vol_len
cfg_obj.USE_VOLUME_FILTER = ucfg.smc_use_volume_filter
key = _analysis_key(cfg_obj)   # (FVG_ENABLED, CHOCH_ENABLED, OB_USE_BREAKER, OB_MAX_AGE_CANDLES, SWEEP_CLOSE_REQUIRED, VOL_LEN)
if high_wr_mode: cfg_obj.MIN_CONFIRMATIONS = max(cfg_obj.MIN_CONFIRMATIONS, 4); pd_filter = mtf_check = True
else:            pd_filter, mtf_check = ucfg.smc_pd_filter, ucfg.smc_mtf_check
an = SMCAnalyzer(SMCConfig(FVG_ENABLED=key[0], CHOCH_ENABLED=key[1], OB_USE_BREAKER=key[2],
                           OB_MAX_AGE_CANDLES=key[3], SWEEP_CLOSE_REQUIRED=key[4], VOL_LEN=key[5]))
analysis = an.analyze(symbol, df_htf, df_mtf, df_ltf)
analysis["squeeze_score"] = compute_squeeze_score(df_mtf)       # c8 confirmation, injected by the scanner
sig = build_smc_signal(symbol, analysis, cfg_obj, tf_htf="4H", tf_mtf="1H", tf_ltf="15m",
                       allowed_dirs=("LONG", "SHORT"), conf_type=ucfg.smc_conf_type,
                       pd_filter=pd_filter, retrace_depth=ucfg.smc_retrace_depth, mtf_check=mtf_check)
```

Note that the analyzer's own `SMCConfig` keeps its class defaults for everything not in the analysis
key (e.g. `OB_MIN_IMPULSE_PCT=0.15, FVG_MIN_GAP_PCT=0.08, SWEEP_WICK_RATIO=0.3,
EQUAL_THRESHOLD_PCT=0.1, SWING_LOOKBACK=10`), while `cfg_obj` (builder) carries the user values —
both objects are dumped per variant (`smc_config`, `analysis_key`, `build_kwargs`).

| variant | SMCUserCfg overrides | high_wr_mode |
|---|---|---|
| default | — (`min_confirmations=3, min_rr=2.0, sl_buffer_pct=0.35, fvg/choch/breaker=True, ob_max_age=80, sweep_close_req=True, smc_conf_type=BODY_CLOSE, smc_pd_filter=False, smc_retrace_depth=0.2, smc_mtf_check=False, smc_use_volume_filter=False, smc_vol_mult=1.2, smc_vol_len=20`) | False |
| conservative | `min_confirmations=4, min_rr=2.5, smc_pd_filter=True, smc_mtf_check=True, smc_retrace_depth=0.5, smc_use_volume_filter=True` | True |
| active | `min_confirmations=2, min_rr=1.5, smc_conf_type=WICK_TOUCH, smc_retrace_depth=0.0, sweep_close_req=False, ob_max_age=50, smc_vol_mult=1.0` (→ different analysis key) | False |

Recorded per signal: every `SMCSignalResult` field (`symbol, direction, score, grade, entry_low,
entry_high, entry, sl, tp1, tp2, tp3, rr, risk_pct, confirmations [[label, bool]×8], narrative,
session, tf_htf, tf_mtf, tf_ltf, mode_tag`) plus `i, ts, open_time_ms, n_mtf_bars, n_htf_bars,
n_ltf_bars, squeeze_score, rr_ladder` (R to tp1/tp2/tp3, as `smc/scanner._rr_ladder`) and
`passes_ctx_gate = score >= cfg_obj.MIN_CONFIRMATIONS` (the scanner's "CTX-GATE" re-check).
`expected/smc_analysis.json` holds, for every swept bar and the default analysis key, a digest of
the analysis dict (trend, bos, choch, swing counts, equal highs/lows, sweeps, both OBs incl.
impulse FVG, nearest FVGs, P/D zone, ATR, volume ratio, squeeze score).

## VOLUME — `volume_strategy.analyze_volume`

Call (as `volume_scanner._scan_cycle` → `_analyze_with_htf`):

```python
from volume_strategy import VolumeConfig, analyze_volume
cfg = VolumeConfig.from_params(params)                # = volume_scanner.load_user_cfg (kv JSON) ; {} → defaults
sig = analyze_volume(symbol, df, cfg, "1h", df_htf)   # → VolumeSignal | None   (df_htf only when cfg.use_htf)
```

| variant | params | profile |
|---|---|---|
| default | `{}` (`VolumeConfig()` defaults, `min_quality=3`, `use_htf=True`) | active (profiles.py: volume_min_quality 3) |
| conservative | `min_quality=4, vol_mult=2.0, trend_filter=True, use_htf=True, bounce_vol_mult=1.2` | conservative (profiles.py: 4) |
| active | `min_quality=2, ma_type="ema", ma_fast=9, ma_mid=21, trend_filter=False, use_htf=False, vol_mult=1.2` | — (exercises EMA-mode, no trend filter, no HTF) |

The live scanner first runs a pre-pass `analyze_volume(df, replace(cfg, use_htf=False,
min_quality=cfg.min_quality-1), "1h")` and only loads HTF when it returns a signal (claimed to be a
superset). The recorded value is the direct call with HTF; `scanner_prepass_mismatch_bars` lists
bars where the pre-pass would have blocked a signal the direct call produced (count in
`summary.json`).

Recorded per signal: every `VolumeSignal` field (`symbol, direction, entry, sl, tp1, tp2, tp3, rr,
quality, signal_type, rsi, vol_ratio, ema_fast, ema_slow, ema_trend, atr, timeframe,
is_counter_trend, reasons, setup, ma_label, ma_value, ma_slow, ema_mid, aligned, squeeze,
alignment, htf_tf, htf_state, confluence, pattern, ma_names, ema_names`) + the properties `tp,
risk_pct, volume_ratio`, `i, ts, open_time_ms, n_bars, n_htf_bars`, and the scanner's pure
post-step `apply_squeeze_bonus`: `squeeze_score` (0 for bounce/ribbon setups, else
`compute_squeeze_score(df)`), `quality_after_squeeze = min(5, quality+1) if squeeze_score >= 1`,
`passes_ctx_gate = quality_after_squeeze >= cfg.min_quality`.

## Signal counts

| strategy | variant | signals | fixtures with ≥1 signal | errors |
|---|---|---|---|---|
| levels | default | 28 | 9 / 42 | 0 |
| levels | conservative | 12 | 4 / 42 | 0 |
| levels | active | 15 | 9 / 42 | 0 |
| smc | default | 3642 | 42 / 42 | 0 |
| smc | conservative | 377 | 40 / 42 | 0 |
| smc | active | 4697 | 42 / 42 | 0 |
| volume | default | 109 | 33 / 42 | 0 |
| volume | conservative | 107 | 33 / 42 | 0 |
| volume | active | 137 | 35 / 42 | 0 |

Per regime (default variant):

| regime | levels | smc | volume |
|---|---|---|---|
| market | 0 | 114 | 10 |
| trending_up | 1 | 683 | 26 |
| trending_down | 1 | 732 | 33 |
| ranging | 9 | 695 | 16 |
| volatile | 0 | 486 | 21 |
| low_volume | 17 | 932 | 3 |

LEVELS reject-reason totals (bars returning `None`): default: zones=3200, volume=2950, signal=1962, rr=97, rsi=86, levels_filter=64, sl_risk=13; conservative: volume=3218, zones=3199, signal=1731, rsi=88, rr=82, quality_hwr=47, levels_filter=12, sl_risk=11; active: volume=2847, signal=2677, zones=2603, rr=104, rsi=75, levels_filter=71, sl_risk=8

VOLUME scanner pre-pass mismatches (bars where the live pre-pass would block a direct-call signal): default=6, conservative=7, active=0.

No strategy raised on any fixture/bar (the `errors` lists are empty everywhere). Determinism re-check on ['SYNRG01-USDT-SWAP', 'SYNVL01-USDT-SWAP', 'BTC-USDT-SWAP']: identical=True. SHA-256 of the expected files is recorded in `summary.json`.

About the counts:

* **LEVELS is sparse by design of the strategy, not of the fixtures.** With production defaults a
  LEVELS signal needs, on the same bar: a zone within 1.5 %, a reversal pattern / fakeout, volume ≥
  0.7× average, ≤ 3 of the previous 9 bars inside the ±0.7 % band of the level, ≤ 3 tests in 30 bars,
  R:R ≥ 2 with the nearest opposite zone as TP1, **and** `market_regime.detect_regime` must not be
  trending (|EMA50 drift over 25 bars| < 0.1 %, `LEVELS_REGIME_GATE=enforce`). Only a quiet market
  with repeated sweeps of one equal-low/high level satisfies all of them at once; the `ranging` /
  `low_volume` fixtures contain such "quiet_sfp" legs (see `legs_last_1h_window`), which is where
  the 55 signals come from (fixtures: SYNLV01-04/08, SYNRG01/04, SYNDN04/07, SYNUP05/08). Trending
  fixtures are rejected by the regime gate (`reject_reasons = levels_filter`) or earlier gates — all
  those `None` results, with their reason, are part of the golden data too.
* **SMC fires on consecutive bars** (the pure function is evaluated every bar; production collapses
  repeats with `signal_registry` 4 h dedup per symbol+direction and the per-user quotas, none of which
  is part of the pure function). Scores < MIN_CONFIRMATIONS in the conservative variant are mem-coin
  capped scores (`passes_ctx_gate=false`).
* File sizes: `smc.json` ≈ 19 MB (8 716 signals, each with its Russian narrative and 8
  confirmations), `smc_analysis.json` ≈ 12 MB, `levels.json` ≈ 0.5 MB, `volume.json` ≈ 0.6 MB,
  candles ≈ 8 MB.
* `verify.py` re-checks the structure of the generated set (alignment of timestamps, OHLC sanity,
  TP ladders ordered, ≥ 20 signals per strategy) and `make_golden.log` is the console log of the run
  that produced the shipped files.

## Non-determinism found and how it was removed

* `indicator.CHMIndicator` keeps a per-symbol **zone cache keyed on `time.time()`** (TTL 600–7200 s by
  TF) and a **cooldown map** (`_last_signal`, `COOLDOWN_BARS`). A fresh instance is used for every
  bar: the cache is then always cold (in production the TTL is shorter than one bar, so zones are
  recomputed from the same closed-bar frame anyway — the cached "pre-filter" shortcut only ever
  returns `None` where the full path also returns `None`), and the cooldown is never armed
  (production arms it in `mark_signal()` **after** Telegram delivery, not inside `analyze()`).
  A port must therefore implement `analyze()` without these two states to match the fixtures.
* `momentum_detector` "relaxed mode" (global, time-based; relaxes `MIN_RR`, `MIN_CONFIRMATIONS`,
  min quality) — off (asserted); `market_regime.get_cached_regime()` (global, 4 h TTL; SL
  multiplier) — empty → multiplier 1.0; `sl_v2.*_enabled()` env flags — off (shadow mode, legacy SL).
* `levels_filters` regime gate uses `market_regime.detect_regime(df, tf)` — pure, left ON (production
  default `enforce`).
* `_kde_bw_cached_impl` is an `lru_cache` keyed on bucketed (n, std/range) — pure.
* `squeeze_detector` thresholds come from env — pinned to the defaults.
* `smc/scanner` would also add `trend_monitor.apply_mtf_bonus` (±1 score from the live BTC trend),
  `momentum_veto`, coin blacklist, freshness and registry dedup — all live-state dependent and NOT
  applied; same for LEVELS (`apply_mtf_bonus`, `allow_counter_trend` gate which needs the live BTC
  regime, cross-strategy dedup, free-tier quotas) and VOLUME (`apply_mtf_bonus`, per-user direction
  toggles, 3-signals-per-cycle cap).
* `analyze_volume` swallows exceptions (returns `None` + `[VOLUME-ERR]` warning) and
  `SMCAnalyzer.analyze` stores exceptions in `analysis["error"]`; both are captured into `errors` /
  `warnings` so a failure is never silently recorded as "no signal".

## Notes for the porter — inputs the strategies read beyond OHLCV, and numeric details

LEVELS (`indicator.py`)
* `symbol`: mem-coin keywords (`FLOKI PEPE SHIB DOGE WIF BONK NEIRO MEME SATS TURBO CATS ACT BOME
  BOOK`) → min stop 1.5 % and quality cap 5; `BTC`/`ETH` substring → min stop 0.4 %; other → 0.8 %.
* `df.index[-1].hour` (UTC) → session label and dead-session −2 quality (`0–8` Asia, `21–24` dead);
  HIGH_WR_MODE additionally rejects hours `< 8` or `>= 22`.
* `df_btc`/`df_eth`: `close` reindexed to `df.index` (`method="nearest"`), `rolling(min(50, len-1)).corr`.
* `df_htf` (1D): `_mark_htf_confluence` (zones of the HTF frame via `_get_zones`, tolerance 0.5·ATR of
  the 1h frame → `mtf_label="MTF"`, class ≤ 2, +1 quality) and, if `USE_HTF_FILTER`, EMA-50 trend
  confluence (+1).
* EMA = `ewm(span, adjust=False)`; RSI = `100 - 100/(1 + ewm_span(gains)/ewm_span(losses))` with
  **span = 14, adjust=False** (not Wilder's α=1/14); ATR = `ewm(span=14, adjust=False)` of the true
  range.
* Zones: pivots = strict window max/min over `±PIVOT_STRENGTH` bars; KDE layer =
  `scipy.stats.gaussian_kde(pivots, bw_method=factor)` where `factor = 1.06·(std_bucket/1000)·n^-0.2`,
  `std_bucket = round(std/range·1000)` (a scalar `bw_method` in scipy is the *factor* multiplying the
  data std; falls back to `"silverman"` when `_kde_bw_cached` returns None), evaluated on 500 points of
  `linspace(low.min(), high.max())`, peaks = `scipy.signal.argrelextrema(np.greater, order=10)`;
  volume-profile layer = 50 bins, bar volume spread equally over the bins its range covers, HVN
  > 1.5·avg, LVN < 0.5·avg; clustering buffer = `atr_now·ZONE_BUFFER`; psychological levels per
  `_is_psychological_level` (step ≥ 1 % of price, within 0.3 %).
* Mechanical TP scale by ATR%: `>3 % → 1.2`, `<1 % → 0.85`, else 1.0; TP1 mechanical R floored at
  `MIN_RR`; structural TPs = opposite zones ×(1 ∓ 0.0005).

SMC (`smc/*.py`)
* `symbol`: mem-coin keywords cap the score at 3; `BTC`/`ETH` → min stop 0.25 %, mem-coin 0.8 %,
  other 0.4 %; risk must be ≥ 1.0·ATR (ATR = `ewm(span=14, adjust=False)` on the MTF frame).
* `vol_ratio` = last MTF volume / mean of the previous `VOL_LEN` bars (excluding the last).
* `squeeze_score` (c8) from `squeeze_detector.compute_squeeze_score(df_mtf)`: BB width
  `(sma20 ± 2·std20(ddof=0))/sma20`, percentile over the last 50 widths via `Series.quantile`
  (linear interpolation), ATR here is a **simple rolling mean** of TR (14 and 50).
* `build_smc_signal` tries LONG then SHORT and keeps the higher score (ties → LONG); the
  `liquidity_sl_adjuster` pushes the SL beyond equal-low/high clusters within 0.5 %.

VOLUME (`volume_strategy.py`)
* `timeframe` string → `HTF_MAP`, labels; `df_htf` → `htf_state` (EMA-50 of the HTF closes with
  `ewm(span, adjust=True, min_periods=1)`, slope over 3 bars → ±2/±1/0).
* EMA = `ewm(span, adjust=True, min_periods=1)` (**adjust=True**, unlike LEVELS/SMC); SMA =
  `rolling(n, min_periods=n)`; RSI = Wilder (`ewm(alpha=1/n, adjust=False)`, NaN → 50); ATR =
  `ewm(alpha=1/n, adjust=False)` of TR; volume average = `shift(1).rolling(vol_len).mean()`
  (excludes the signal bar). `min_bars(cfg)` = 225 for the defaults — bars with fewer rows return
  `None` (first signals possible from i = 224).
* Quality 1..5, `min_quality` applied inside the function (before the scanner's squeeze bonus).

General
* All three functions use `iloc[-1]` as the last CLOSED bar (the frames carry no forming bar).
* `float(f"{x:.10g}")` rounding is applied only when writing the fixtures; compare with a relative
  tolerance of ~1e-9 (values are produced by float64 pandas/numpy pipelines).
