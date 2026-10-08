# services/genome: Strategy Genome (M16)

This is a one-to-one port of the bot's genetic optimiser: `genome.py`, `genome_ui.py`,
`genome_maintenance.py`, `handlers/genome.py`, the genome path of `backtest.py`
(`Backtester.run_in_thread`, `_simulate_trade`, `_build_result`) and the scanner side of
`optimizer.py` (`params_for_regime`). The source of truth is `/home/user/MAIN_BOT/CHM_BREAKER_V4`.
Every pure function is pinned by vectors that the bot's own Python computes
(`tests/genome/make_genome_vectors.py` writes them to `tests/genome/fixtures/*.json.gz`).

## Modules

| Module | Bot counterpart | Notes |
|---|---|---|
| `config.js` | genome constants, `get_tfs`, `get_default_tf`, `_eval_days_for_tf`, `_eval_timeout_for_tf`, drift / PF / age-window tables, `[GENOME-CPU-BUDGET]`, `get_dynamic_eval_days` | `genomeCpuShare(env, nCpu)`: `GENOME_CPU_SHARE`, clamped to 0.05–1. The default is 0.15 on a 1-CPU host and 0.35 otherwise. |
| `rng.js` | `random` (subset) | mulberry32, seedable. It implements `random`, `randbelow`, `randint`, `choice`, `sample` and `shuffle` with CPython's algorithms. |
| `geneSpace.js` | `GENE_SPACE`, `random_gene_value`, `serialize_genome`, `json.dumps` | Keeps the float-step truncation quirk. `pyDumps` gives Python float/int formatting. `parsePyJson` keeps int/float literal kinds. `pyJsonLoads` reads `NaN`/`Infinity`. |
| `constraints.js` | `_fix_constraints` | Same rules, in the same order, including random filling of missing VOLUME genes. Ordered comparisons raise TypeError for a None / str operand like CPython. |
| `operators.js` | `random_genome`, `crossover`, `mutate`, `tournament_select`, `bayesian_mutate`, cross-strategy hint, fitness decay | |
| `backtester.js` | `Backtester` (genome subset) | Runs over the site engines (LEVELS `doAnalyze`, SMC `analyze` + `buildSmcSignal`, VOLUME context/mask/signal). Fees, MAE/MFE and the numpy rounding/summation of averages are emulated (`npRound`, `cpySum`). |
| `fitness.js` | `compute_fitness`, Wilson CI, Monte Carlo DD, the `evaluate_genome` multipliers | `pyLog1p` pins glibc `log1p` at n = 175 and 184, where V8 differs by 1 ulp. |
| `evaluate.js` | `evaluate_genome` | Covers the eval cache (sha1[:16]), CPU pacing, coin-champion kv, log markers (`ZERO`, `EMPTY-RESULTS`, `LOW-TRADES`, `[FIT-BREAKDOWN]`) and cooperative deadlines (`DeadlineError`). |
| `coinBasket.js` | `_get_context_aware_coins`, `_get_top_coins_cached`, `_get_tier2_dynamic`, `_build_tier_mixed_basket` | HTTP is injected. CoinGecko is never called from tests. |
| `drift.js` / `paperValidation.js` | `check_drift`, `validate_via_paper` | These read `signal_trades`. kv `genome_live_baseline_<S>_<tf>`. |
| `apply.js` | `apply_best_to_user`, `_auto_apply_best_genome`, `_user_tfs_for_strategy` | LEVELS goes to `trader_settings` columns, SMC to the `smc_cfg` JSON merge, VOLUME to the volume cfg service. Auto-apply writes `optimizer_params`. |
| `optimizerParams.js` | `optimizer._normalize_regime`, `params_for_regime`, scanner_mid ШАГ 9, the smc/scanner hoist and filter | This is the read side of what auto-apply writes. It is pure and the scanners call it. |
| `evolve.js` | `evolve_generation`, `meta_adapt`, `trigger_evolution_now`, `run_evolution_cycle`, `genome_evolution_loop` | One generation per call. All deadlines are checked before every genome. |
| `texts.js` | `genome_ui.py`, `handlers/genome.py` texts and keyboard | The Russian texts are verbatim. |
| `maintenance.js` | `genome_maintenance.py` | Coin-champion GC and live-baseline refresh. |
| `store.js` | genome DB helpers, `optimizer._save_params` / `load_params` + `optimizer_cache` | Uses the site DB through better-sqlite3 (`setDb` is injectable for the worker). |
| `regime.js` | `market_regime.get_cached_regime` | A provider hook. It returns `null` until the engine worker installs a provider. |
| `runner.js` | (site) | Spawns `workers/genomeWorker.js` on demand and owns the evolution lock. |

Entry points outside this folder:

- `workers/genomeWorker.js`: `worker_threads` entry. It runs one `evolve` message (one generation) at nice 19 (on Linux this is thread-level) and posts `progress` and `result` messages. It is **not** started automatically. `runner.runGenerationInWorker` spawns it, and the tests do so explicitly.
- `routes/appGenome.js`: `GET /api/app/genome`, `POST /api/app/genome/apply` (the Mini App shapes) and `POST /api/app/genome/evolve` (D10, Pro). The router is mounted from `routes/app.js` under its auth and POST rate limit.

## Design decisions

- **Exact numerics.** The bot's CPython 3.11 `sum()` (`pySum`, plain left-to-right), round-half-even `round()`, numpy float64 `round` (`rint(x·10^k)/10^k`) and mixed float/np.float64 summation (`cpySum`: the result is np.float64 once an item is) are reproduced wherever the bot uses them. This makes fitness, the trade lists (SMC liquidity-adjusted prices included) and the result dicts bit-for-bit equal to the bot on the golden candles.
- **RNG.** The JS generator cannot be CPython's Mersenne Twister. The vector generator therefore replaces `genome.random` with a mulberry32 shim that uses the same algorithms, so the operators are compared draw-for-draw. `crossover` iterates a Python `set` (hash order), so only its invariants are pinned.
- **Monte Carlo** uses the JS RNG (`createRng(42)`), so its p95 drawdown differs from Python's `random.Random(42)` **by design**. The parity tests inject Python's p95 (`opts.mcP95Dd`). The MC formula itself is pinned separately.
- **Timeouts.** The bot's `asyncio.wait_for` calls become cooperative deadlines (`DeadlineError` kind `genome` / `generation` / `manual`). They are checked before every genome and every coin, which gives the same 1800 s generation abort and the same 700 s manual abort with the same Russian texts.
- **CPU share.** After every coin backtest the worker sleeps `min(20, elapsed·(1/share − 1))`. The per-genome timeout is the TF timeout divided by the share.
- **Unknown TF on `/evolve`** falls back to the strategy's default TF. The bot only ever receives TFs from its own buttons.
- **`_save_params` never raises.** The bot logs a warning and auto-apply still counts the user as applied, and the port does the same. `load_params` keeps the 4 h `optimizer_cache` TTL and returns non-dict JSON as-is, like `json.loads`.

## Re-generating the vectors

```
VENV=/path/to/python3.11-venv/bin/python   # the production interpreter + the bot's pinned requirements
BOT_TOKEN_CHM=test:token ADMIN_IDS=123 $VENV backend/tests/genome/make_genome_vectors.py [section …]
rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
```

Sections: `gene_space constraints operators fitness evaluate simulate backtests db coins handlers optimizer`.
The bot repo is only read. Temporary SQLite files go to a temp dir that the generator removes.
An all-sections run restores the real `database.db_kv_get` / `db_kv_set` after `evaluate` and
`backtests` (which install a fake kv), so the DB sections see the real kv.

The adversarial verification vectors (fresh inputs, never those above) come from
`backend/tests/genome/make_genome_verify_vectors.py` and are replayed by `verifyPure.test.js` /
`verifyDb.test.js`:

```
BOT_TOKEN_CHM=test:token ADMIN_IDS=123 $VENV backend/tests/genome/make_genome_verify_vectors.py [section …]
GENOME_VERIFY_ONLY=LEVELS $VENV …/make_genome_verify_vectors.py backtests   # one strategy per process (LEVELS 15m ≈ 12 min)
```

Sections: `constraints` (500 genomes per strategy), `fitness` (200 trade lists + compute_fitness
edges), `backtests` (6 golden coins × 15m × 5 genomes per strategy, + evaluate_genome), `wide`
(the same genomes on 1h / 4h over 12 coins), `apply` (20 apply_best_to_user scenarios per
strategy), `routes` (the real `miniapp_api.h_genome` / `h_genome_apply`).

## Known gaps (outside this folder's ownership)

- **Scanners do not read `optimizer_params` yet.** The LEVELS/SMC scanners (services/engine, strategies/levels) must call `optimizerParams.applyLevelsOptimizerParams(cfg, user)` before building the LEVELS indicator config, and `smcOptimizerFilters(user)` together with `smcPassesOptimizerFilters` in the SMC per-user loop. Until they do, auto-apply writes rows that nothing reads.
- **Regime provider.** The engine worker must install `regime.setRegimeProvider(() => cachedBtcRegime)`. Without it, drift, paper validation and `params_for_regime` all see `null` (the "unknown" defaults).
- **Schedulers.** The 6 h evolution cycle (`evolve.genomeEvolutionLoop` / `runner.triggerEvolution(..., {mode: 'cycle'})`) and `maintenance.runGenomeMaintenanceLoop` are deliberately not started. The scheduler process has to wire them.
- **Admin route.** No admin route for evolution was added. The user-facing D10 route is `/api/app/genome/evolve`.
- **Malformed request bodies.** The global `express.json()` in `server.js` answers a body that is
  not a JSON object/array (`not json`, `"LEVELS"`) with 400 `{error: <parse message>}` before the
  router runs. The bot's `_read_body()` reads such a body as `{}`, so `POST /genome/apply` answers
  `pro_required` (free) or 400 `bad_strategy` (Pro). Well-formed bodies are identical.

## Not reproducible by design

- **int/float kind of out-of-kind numbers.** JS numbers do not carry Python's int/float kind, so
  `serialize_genome` infers it from the gene (`FLOAT_GENE_KEYS`). An int in a float gene (`"min_rr": 2`)
  or an integral float in an int gene (`"min_quality": 4.0`) serialises differently. The bot's
  operators never produce such values; the repaired VALUES are identical in every case.
- **Bot-only `users` columns.** LEVELS apply writes every genome key that is a column of the bot's
  `users` table. Columns the site keeps elsewhere or not at all (`username`, exchange API keys,
  `watch_coin`, `copy_*`, …) are not gene names, so a genome never carries them.
- **`smc_cfg` NULL.** `trader_settings.smc_cfg` is `NOT NULL DEFAULT '{}'`; the bot reads a NULL
  `smc_cfg` as `"{}"`, so the two states behave the same.
