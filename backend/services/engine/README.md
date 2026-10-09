# services/engine — trader_settings ↔ bot `UserSettings` mapping

One reference for every later milestone (M7 `tradeCfg.js` / `traderSettingsService`,
M9 scanners, M13 auto-trade, M18 bot import). The schema itself lives in
`backend/models/engineSchema.js` (DDL + column lists; `tests/migrations.test.js`
pins every default) and is applied by `backend/models/migrations.js`:

| Migration | Name | Creates |
|---|---|---|
| v10 | `engine_core` | `trader_settings`, `signal_trades`, `engine_kv`, `trade_events`, `plan_changes` |
| v11 | `genome` | `genome_population`, `genome_history`, `optimizer_params` |
| v12 | `retire_bots` | exports + drops the per-bot product's tables (PLAN §2.1), drops `users.paper_starting_balance` / `users.public_profile`, remaps `subscriptions` to `free` / `pro` (D1), inserts a default `trader_settings` row for every user |

Specs: `port/specs/data-and-market.md` §1.2 (users), §1.3 (trades), §1.4 (other
tables), §1.5 (kv keys); `genome-challenge-profiles.md` §1.14 (genome storage);
`PLAN.md` §2.1 (table mapping and the retire list).

## Conventions

* `trader_settings.user_id` = `users.id` (integer). Bot Telegram ids live in
  `users.tg_id`; a migrated bot user is pre-created with `tg_id`, `email =
  tg_<id>@chm.local` (PLAN §2.5), so bot `users.user_id` → `users.tg_id` → `users.id`.
* One row per user, **PK `user_id REFERENCES users(id) ON DELETE CASCADE`**. Every
  column is `NOT NULL DEFAULT <dataclass default>`, so `INSERT INTO trader_settings
  (user_id) VALUES (?)` yields exactly what `UserSettings(user_id).to_db()` writes
  for a new bot user.
* Defaults are the **dataclass** defaults (`user_manager.py:UserSettings`), not the
  bot's `CREATE TABLE` defaults. The two differ for: `scan_interval` 300 (DB 3600),
  `min_volume_usdt` 300000 (DB 1000000), `partial_tp_enabled` 1 (DB 0),
  `partial_tp1_pct` 50 (DB 40), `partial_tp2_pct` 40 (DB 30), `sub_status`
  `'expired'` (DB `'trial'`), `trial_used` 1 (DB 0), `ui_mode` `'simple'` (DB
  `'expert'`). When importing bot rows (M18) copy the *stored* values verbatim; the
  defaults only matter for rows created on the site.
* Booleans are `INTEGER` 0/1 (bot `to_db()` writes `int(v)`, `_from_db()` reads
  `bool(v)`); times are `REAL` unix seconds (UTC); JSON columns (`long_cfg`,
  `short_cfg`, `smc_cfg`, `ai_filter_settings`) are stored as the bot's
  `json.dumps` text — `ai_filter_settings` default is the literal
  `{"market_regime": true, "news_monitor": true, "genome_engine": false}` with
  Python's spacing.
* `strategy` is normalised to `LEVELS` when not in (`LEVELS`,`SMC`,`VOLUME`);
  `sub_plan` always holds a normalised id (`free` / `pro`, `config/planFeatures.normalizePlan`);
  `lang` is `ru` / `en` (anything else reads as `ru`).
* `created_at` is set once and **never updated** on save (`db_upsert_user` conflict
  rule); `updated_at` is set to `now` on every save. v12 sets both to the migration
  time for existing site users.
* `sub_plan` / `sub_status` / `sub_expires` are a **mirror** of `subscriptions`,
  maintained by `planService` (M7, single writer) so engine code reads one row. v12
  initialises it: active paid subscription → (`pro`, `active`, unix(expires_at));
  everything else → the dataclass defaults (`free`, `expired`, 0). Bot semantics:
  `db_get_active_users` selects `sub_plan='free' OR (sub_status IN ('trial','active')
  AND sub_expires > now)` plus any `*_active` flag; `check_access()` tests
  `sub_plan == 'free'` **before** `sub_status`, so a free user is never "expired".
* Sub-objects that are *not* columns: `TradeCfg` (shared cfg = the `pivot_strength …
  cooldown_bars` columns; LONG/SHORT = sparse JSON in `long_cfg` / `short_cfg`,
  merged by `_sparse_merge` — §2.3), `SMCUserCfg` (JSON in `smc_cfg`, unknown keys
  ignored, defaults on parse error — §2.5), `VolumeConfig` (engine_kv
  `volume_cfg_<uid>` — strategy-volume.md), `Challenge` (engine_kv
  `challenge_<uid>` — genome-challenge-profiles.md §2.1).
* Factory reset (`db_reset_user_settings`) rebuilds the defaults but keeps the
  `_RESET_PRESERVE` set: identity, `lang`, `active`, every subscription/reminder
  column, `onboarding_done`, `trade_exchange`, `bybit_demo`, all `prop_*` (API keys
  are in `exchange_keys`, untouched by definition).

## trader_settings — columns (bot `users` order, §1.2)

| Column | Type | Default | Bot `UserSettings` field / note |
|---|---|---|---|
| `active` | INTEGER | `0` | `active` — legacy "scanner on" flag; any_active(), db_get_active_users |
| `sub_status` | TEXT | `'expired'` | `sub_status` — mirror of subscriptions (planService): trial/active/expired/banned |
| `sub_expires` | REAL | `0` | `sub_expires` — mirror: unix seconds when paid access ends |
| `trial_started` | REAL | `0` | `trial_started` — unused (no trial) |
| `trial_used` | INTEGER | `1` | `trial_used` — always 1 (trial disabled) |
| `timeframe` | TEXT | `'1h'` | `timeframe` — shared LEVELS TF (legacy scan_mode=both job) |
| `scan_interval` | INTEGER | `300` | `scan_interval` — shared LEVELS scan interval (s) |
| `pivot_strength` | INTEGER | `7` | `pivot_strength` — LEVELS shared cfg (TradeCfg) |
| `max_level_age` | INTEGER | `100` | `max_level_age` |
| `max_retest_bars` | INTEGER | `30` | `max_retest_bars` |
| `zone_buffer` | REAL | `0.3` | `zone_buffer` |
| `ema_fast` | INTEGER | `50` | `ema_fast` |
| `ema_slow` | INTEGER | `200` | `ema_slow` |
| `htf_ema_period` | INTEGER | `50` | `htf_ema_period` |
| `rsi_period` | INTEGER | `14` | `rsi_period` |
| `rsi_ob` | INTEGER | `65` | `rsi_ob` |
| `rsi_os` | INTEGER | `35` | `rsi_os` |
| `vol_mult` | REAL | `1.0` | `vol_mult` |
| `vol_len` | INTEGER | `20` | `vol_len` — no UI |
| `use_rsi` | INTEGER | `1` | `use_rsi` |
| `use_volume` | INTEGER | `1` | `use_volume` |
| `use_pattern` | INTEGER | `0` | `use_pattern` |
| `use_htf` | INTEGER | `0` | `use_htf` |
| `atr_period` | INTEGER | `14` | `atr_period` |
| `atr_mult` | REAL | `1.0` | `atr_mult` |
| `max_risk_pct` | REAL | `1.5` | `max_risk_pct` — also the hard cap for auto-trade risk |
| `tp1_rr` | REAL | `2.0` | `tp1_rr` |
| `tp2_rr` | REAL | `3.0` | `tp2_rr` |
| `tp3_rr` | REAL | `4.5` | `tp3_rr` |
| `zone_pct` | REAL | `0.7` | `zone_pct` |
| `max_dist_pct` | REAL | `1.5` | `max_dist_pct` |
| `min_rr` | REAL | `2.0` | `min_rr` |
| `max_level_tests` | INTEGER | `4` | `max_level_tests` |
| `min_volume_usdt` | REAL | `300000` | `min_volume_usdt` — per-user min 24h volume (LEVELS + VOLUME universes); dataclass 300_000, DB default was 1M |
| `min_quality` | INTEGER | `3` | `min_quality` — LEVELS min quality (0..10) |
| `cooldown_bars` | INTEGER | `5` | `cooldown_bars` |
| `notify_signal` | INTEGER | `1` | `notify_signal` — legacy toggle |
| `notify_breakout` | INTEGER | `0` | `notify_breakout` — legacy toggle |
| `scan_mode` | TEXT | `'both'` | `scan_mode` — legacy; both + active=1 creates a BOTH job |
| `long_tf` | TEXT | `'1h'` | `long_tf` — LEVELS LONG job TF |
| `long_interval` | INTEGER | `3600` | `long_interval` |
| `short_tf` | TEXT | `'1h'` | `short_tf` — LEVELS SHORT job TF |
| `short_interval` | INTEGER | `3600` | `short_interval` |
| `long_active` | INTEGER | `0` | `long_active` — LEVELS LONG scanner on |
| `short_active` | INTEGER | `0` | `short_active` — LEVELS SHORT scanner on |
| `smc_long_active` | INTEGER | `0` | `smc_long_active` |
| `smc_short_active` | INTEGER | `0` | `smc_short_active` |
| `vol_long_active` | INTEGER | `0` | `vol_long_active` |
| `vol_short_active` | INTEGER | `0` | `vol_short_active` |
| `vol_timeframe` | TEXT | `'1h'` | `vol_timeframe` — VOLUME TF: 15m / 1h / 4h |
| `long_cfg` | TEXT | `'{}'` | `long_cfg` — sparse JSON override for LONG (§2.3) |
| `short_cfg` | TEXT | `'{}'` | `short_cfg` — sparse JSON override for SHORT |
| `smc_cfg` | TEXT | `'{}'` | `smc_cfg` — JSON of SMCUserCfg (§2.5) |
| `trend_only` | INTEGER | `0` | `trend_only` |
| `signals_received` | INTEGER | `0` | `signals_received` — bumped by LEVELS scanner on delivery |
| `trial_reminder_sent` | INTEGER | `0` | `trial_reminder_sent` — legacy, unused |
| `expired_notified` | INTEGER | `0` | `expired_notified` — "subscription expired" message already sent |
| `created_at` | REAL | `0` | `created_at` — unix seconds; never updated on conflict |
| `updated_at` | REAL | `0` | `updated_at` — unix seconds; set on every save |
| `strategy` | TEXT | `'LEVELS'` | `strategy` — primary strategy LEVELS / SMC / VOLUME |
| `auto_trade` | INTEGER | `0` | `auto_trade` — auto-trade master switch |
| `auto_trade_mode` | TEXT | `'confirm'` | `auto_trade_mode` — auto / confirm |
| `trade_risk_pct` | REAL | `1.0` | `trade_risk_pct` — % of balance risked per trade |
| `trade_leverage` | INTEGER | `10` | `trade_leverage` |
| `max_trades_limit` | INTEGER | `5` | `max_trades_limit` — 0 = unlimited |
| `trade_exchange` | TEXT | `'bybit'` | `trade_exchange` — bybit / bingx / binance / okx → selects exchange_keys row |
| `bybit_demo` | INTEGER | `0` | `bybit_demo` — use api-demo.bybit.com |
| `at_stats_period` | INTEGER | `1` | `at_stats_period` — stats period 1/7/30 days |
| `lang` | TEXT | `'ru'` | `lang` — ru / en |
| `onboarding_done` | INTEGER | `0` | `onboarding_done` |
| `optimizer_enabled` | INTEGER | `0` | `optimizer_enabled` |
| `optimizer_strategies` | TEXT | `'LEVELS'` | `optimizer_strategies` — CSV |
| `fixed_amount` | REAL | `0.0` | `fixed_amount` — fixed $ per trade (0 = use risk %) |
| `autotrade_disabled_days` | TEXT | `''` | `autotrade_disabled_days` — CSV of weekday numbers 0..6 |
| `genome_auto_apply` | INTEGER | `0` | `genome_auto_apply` |
| `vol_filter_mode` | TEXT | `'usdt'` | `vol_filter_mode` — usdt / count / both / off |
| `max_coins_count` | INTEGER | `50` | `max_coins_count` |
| `reminder_3d_sent` | INTEGER | `0` | `reminder_3d_sent` |
| `reminder_1d_sent` | INTEGER | `0` | `reminder_1d_sent` |
| `reminder_7d_after_sent` | INTEGER | `0` | `reminder_7d_after_sent` |
| `reminder_14d_after_sent` | INTEGER | `0` | `reminder_14d_after_sent` |
| `reminder_30d_after_sent` | INTEGER | `0` | `reminder_30d_after_sent` |
| `last_reminder_at` | REAL | `0` | `last_reminder_at` |
| `reminders_optout` | INTEGER | `0` | `reminders_optout` |
| `btc_correlation_block` | INTEGER | `0` | `btc_correlation_block` |
| `partial_tp_enabled` | INTEGER | `1` | `partial_tp_enabled` — dataclass True (DB default was 0) |
| `partial_tp1_r` | REAL | `1.0` | `partial_tp1_r` |
| `partial_tp1_pct` | REAL | `50.0` | `partial_tp1_pct` — dataclass 50 (DB default was 40) |
| `partial_tp2_r` | REAL | `1.5` | `partial_tp2_r` |
| `partial_tp2_pct` | REAL | `40.0` | `partial_tp2_pct` — dataclass 40 (DB default was 30) |
| `risk_mode` | TEXT | `'risk'` | `risk_mode` — risk / notional |
| `sub_plan` | TEXT | `'free'` | `sub_plan` — mirror: free / pro (normalize_plan) |
| `high_wr_mode` | INTEGER | `0` | `high_wr_mode` |
| `prop_mode` | INTEGER | `0` | `prop_mode` |
| `prop_firm` | TEXT | `''` | `prop_firm` |
| `prop_capital` | REAL | `100000` | `prop_capital` |
| `prop_base_risk` | REAL | `1.0` | `prop_base_risk` |
| `prop_target` | REAL | `8.0` | `prop_target` |
| `prop_max_dd` | REAL | `5.0` | `prop_max_dd` |
| `prop_daily_limit` | REAL | `4.0` | `prop_daily_limit` |
| `prop_min_days` | INTEGER | `1` | `prop_min_days` |
| `prop_max_days` | INTEGER | `30` | `prop_max_days` |
| `prop_trailing_dd` | INTEGER | `0` | `prop_trailing_dd` |
| `prop_consistency` | INTEGER | `0` | `prop_consistency` |
| `prop_start_balance` | REAL | `0` | `prop_start_balance` |
| `prop_start_date` | REAL | `0` | `prop_start_date` |
| `prop_day_start_balance` | REAL | `0` | `prop_day_start_balance` |
| `prop_peak_balance` | REAL | `0` | `prop_peak_balance` — atomic UPDATE ... WHERE ? > COALESCE(prop_peak_balance,0) |
| `prop_trading_days` | INTEGER | `0` | `prop_trading_days` |
| `prop_last_trade_day` | INTEGER | `0` | `prop_last_trade_day` — UTC ordinal day |
| `prop_unlocked` | INTEGER | `0` | `prop_unlocked` |
| `allow_counter_trend` | INTEGER | `0` | `allow_counter_trend` |
| `filters_all_off` | INTEGER | `0` | `filters_all_off` — kill-switch for signal filters |
| `sl_streak_enabled` | INTEGER | `1` | `sl_streak_enabled` |
| `sl_streak_threshold` | INTEGER | `3` | `sl_streak_threshold` |
| `circuit_breaker_enabled` | INTEGER | `0` | `circuit_breaker_enabled` |
| `circuit_breaker_threshold_r` | REAL | `0.0` | `circuit_breaker_threshold_r` |
| `allow_low_notional_boost` | INTEGER | `0` | `allow_low_notional_boost` |
| `prefer_market_entry` | INTEGER | `0` | `prefer_market_entry` |
| `show_risk_preview` | INTEGER | `1` | `show_risk_preview` |
| `correlation_cap_enabled` | INTEGER | `0` | `correlation_cap_enabled` |
| `correlation_cap_threshold` | REAL | `0.7` | `correlation_cap_threshold` — 0.5..0.95 |
| `adaptive_sizing_enabled` | INTEGER | `0` | `adaptive_sizing_enabled` |
| `adaptive_sizing_mode` | TEXT | `'all'` | `adaptive_sizing_mode` — all / kelly / vol / dd |
| `tilt_detector_enabled` | INTEGER | `1` | `tilt_detector_enabled` |
| `hold_lock_enabled` | INTEGER | `0` | `hold_lock_enabled` |
| `hold_lock_min_rr` | REAL | `0.5` | `hold_lock_min_rr` |
| `hour_filter_enabled` | INTEGER | `1` | `hour_filter_enabled` |
| `min_signal_quality` | INTEGER | `3` | `min_signal_quality` — 3=B, 4=A, 5=A+ |
| `trade_trending_only` | INTEGER | `0` | `trade_trending_only` |
| `spread_check_enabled` | INTEGER | `1` | `spread_check_enabled` |
| `spread_max_pct` | REAL | `0.3` | `spread_max_pct` |
| `ptp_mode` | TEXT | `'R'` | `ptp_mode` — R / PCT |
| `ptp_profit_pct1` | REAL | `30.0` | `ptp_profit_pct1` |
| `ptp_profit_pct2` | REAL | `50.0` | `ptp_profit_pct2` |
| `free_signals_today` | INTEGER | `0` | `free_signals_today` — legacy = morning+evening sum |
| `free_signals_date` | TEXT | `''` | `free_signals_date` — YYYY-MM-DD UTC |
| `free_missed_today` | INTEGER | `0` | `free_missed_today` |
| `free_smc_preview_today` | INTEGER | `0` | `free_smc_preview_today` |
| `free_smc_preview_date` | TEXT | `''` | `free_smc_preview_date` |
| `smc_max_sl_pct` | REAL | `5.0` | `smc_max_sl_pct` — 0 = off |
| `levels_counter_trend_min_quality` | INTEGER | `4` | `levels_counter_trend_min_quality` — 0..5 stars |
| `smc_counter_trend_min_quality` | INTEGER | `4` | `smc_counter_trend_min_quality` — 0..5 |
| `ui_mode` | TEXT | `'simple'` | `ui_mode` — dataclass simple (DB default was expert) |
| `free_signals_morning` | INTEGER | `0` | `free_signals_morning` |
| `free_signals_evening` | INTEGER | `0` | `free_signals_evening` |
| `free_signals_night` | INTEGER | `0` | `free_signals_night` — always 0 now |
| `send_chart_enabled` | INTEGER | `1` | `send_chart_enabled` |
| `signal_format` | TEXT | `'full'` | `signal_format` — full / lite |
| `ai_filter_settings` | TEXT | `'{"market_regime": true, "news_monitor": true, "genome_engine": false}'` | `ai_filter_settings` — json.dumps of the dataclass default |
| `ai_filter_preset` | TEXT | `'balanced'` | `ai_filter_preset` — safe / balanced / aggressive / custom |
| `ai_show_confidence_score` | INTEGER | `0` | `ai_show_confidence_score` |
| `ai_adaptive_recommendations` | INTEGER | `1` | `ai_adaptive_recommendations` |
| `auto_trailing_enabled` | INTEGER | `1` | `auto_trailing_enabled` |
| `progress_notify_enabled` | INTEGER | `1` | `progress_notify_enabled` |
| `quiet_start` | INTEGER | `-1` | `quiet_start` — quiet hours UTC, -1 = off |
| `quiet_end` | INTEGER | `-1` | `quiet_end` |
| `extra_strategies` | TEXT | `''` | `extra_strategies` — CSV of additional strategies, e.g. SMC,VOLUME |

### Bot `users` columns deliberately not carried over

| Group | Columns | Where they live now |
|---|---|---|
| identity | `username` | `users.display_name` / `users.telegram_username` |
| API keys | `bybit_api_key/secret`, `bingx_api_key/secret`, `binance_api_key/secret`, `okx_api_key/secret/passphrase` | `exchange_keys` (AES-GCM, `label='default'`, `passphrase_encrypted`); `trader_settings.trade_exchange` selects the active row, `bybit_demo` replaces `is_testnet` for Bybit |
| dead | `watch_coin`, `min_position_usdt`, `math_levels_active`, `alert_liquidation/funding/arbitrage/whales/regime/swarm`, `paper_trading`, `copy_public/nickname/bio/followers`, `news_alerts_enabled/filter/timing`, `welcome_bonus_pct`, `last_applied_preset_name` | nowhere (no reader in the bot) |

`engineSchema.TRADER_SETTINGS_EXCLUDED` lists them so the M18 importer can skip
them explicitly.

## signal_trades — bot `trades`, verbatim (§1.3)

`trade_id TEXT PRIMARY KEY` (generated by the scanner, `INSERT OR IGNORE` on
duplicates); `user_id` carries `REFERENCES users(id) ON DELETE CASCADE` on the site.
The 11 bot indexes are created under the `idx_signal_trades_*` prefix (same column
lists; SQLite index names are global and the legacy site `trades` table owned
`idx_trades_*` until v12 dropped it). `engineSchema.SIGNAL_TRADES_ALLOWED_COLS` is
the bot's `_ALLOWED_TRADE_COLS` insert/update whitelist; `signal_msg_id`,
`progress_*`, `signal_card_json`, `expire_rr`, `ai_filter_json`, `tp_retry_count`
are written only by their dedicated UPDATE helpers (M10).

Site-specific meanings: `signal_msg_id` = `notifications.id` of the delivered feed
row (>0 = delivered); `signal_card_json` = `{html, actions, lang}` of the rendered
card. `state` ∈ `PENDING PLACING OPEN CLOSING CLOSED FAILED`; `result` terminal
values `TP1 TP2 TP3 SL BE MANUAL TRAIL` (→ CLOSED) and `SKIP ORPHAN CANCELLED`
(→ FAILED). Retention: SKIP/ORPHAN older than 30 d purged (bot `cache_gc`).

| # | Column | Type | Default |
|---|---|---|---|
| 1 | `trade_id` | TEXT | PRIMARY KEY |
| 2 | `user_id` | INTEGER | NOT NULL |
| 3 | `symbol` | TEXT | NOT NULL |
| 4 | `direction` | TEXT | NOT NULL |
| 5 | `entry` | REAL | NOT NULL |
| 6 | `sl` | REAL | NOT NULL |
| 7 | `tp1` | REAL | NOT NULL |
| 8 | `tp2` | REAL | NOT NULL |
| 9 | `tp3` | REAL | NOT NULL |
| 10 | `tp1_rr` | REAL | `0.8` |
| 11 | `tp2_rr` | REAL | `1.5` |
| 12 | `tp3_rr` | REAL | `2.5` |
| 13 | `quality` | INTEGER | `1` |
| 14 | `timeframe` | TEXT | `'1h'` |
| 15 | `breakout_type` | TEXT | `''` |
| 16 | `result` | TEXT | `''` |
| 17 | `result_rr` | REAL | `0` |
| 18 | `created_at` | REAL | `0` |
| 19 | `trail_level` | INTEGER | `0` |
| 20 | `order_id` | TEXT | `''` |
| 21 | `be_set` | INTEGER | `0` |
| 22 | `tp_placed` | INTEGER | `0` |
| 23 | `risk_pct` | REAL | `1.5` |
| 24 | `pos_idx` | INTEGER | `0` |
| 25 | `leverage` | INTEGER | `1` |
| 26 | `strategy` | TEXT | `''` |
| 27 | `copied_from` | INTEGER | `0` |
| 28 | `state` | TEXT | `'OPEN'` |
| 29 | `state_changed_at` | REAL | `0` |
| 30 | `placement_attempts` | INTEGER | `0` |
| 31 | `closed_pnl_usd` | REAL | `NULL` |
| 32 | `qty` | REAL | `0` |
| 33 | `original_sl` | REAL | `NULL` |
| 34 | `order_link_id` | TEXT | `''` |
| 35 | `signal_type` | TEXT | `''` |
| 36 | `skip_reason` | TEXT | `''` |
| 37 | `entry_lo` | REAL | `0` |
| 38 | `entry_hi` | REAL | `0` |
| 39 | `exchange` | TEXT | `'bybit'` |
| 40 | `tp_retry_count` | INTEGER | `0` |
| 41 | `rsi` | REAL | `50.0` |
| 42 | `volume_ratio` | REAL | `1.0` |
| 43 | `is_counter_trend` | INTEGER | `0` |
| 44 | `mtf_aligned` | INTEGER | `0` |
| 45 | `trend_ctx` | TEXT | `''` |
| 46 | `btc_corr` | REAL | `0.0` |
| 47 | `session` | TEXT | `''` |
| 48 | `preset_name` | TEXT | `NULL` |
| 49 | `ai_filter_json` | TEXT | `NULL` |
| 50 | `signal_msg_id` | INTEGER | `0` |
| 51 | `progress_stage` | TEXT | `''` |
| 52 | `progress_ts` | REAL | `0` |
| 53 | `signal_card_json` | TEXT | `''` |
| 54 | `expire_rr` | REAL | `NULL` |
| 55 | `user_note` | TEXT | `''` |

## engine_kv — bot `kv`, verbatim namespace

`key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL`. Separate from the
site's `system_kv` so every bot key imports 1:1 (§1.5): `trend_state_v1`,
`trend_aligned_v1`, `trend_notify_off_<uid>`, `volume_cfg_<uid>`, `challenge_<uid>`,
`drip_sent_day{N}_<uid>`, `entry_advice_<uid>`, `analyze_count_<uid>_<unixday>`,
`idemp_v1_<key>`, `zb_cooldown_*`, `scanner_trail_fail_until_v1`,
`scanner_tp_fail_until_v1`, `free_missed_buffer`, `free_closed_profitable`,
`free_preview_sent`, `weekly_digest_last_week`, `regime_history`, `coin_quality_*`,
`genome_evolution_last_ts_v1`, `genome_live_baseline_{S}_{tf}`,
`genome_coin_champ_{S}_{tf}_{coin}`, `miniapp_genome_applied_{uid}_{S}`,
`signal_registry`, `bybit_mode:<api_key_hash>` (replaces the `bybit_account_mode`
table), plus the one-shot migration flags (`migr_*`). TON keys (`pending_ton_sub_*`,
`ton_tx_done_*`) are Telegram-only and are not imported.

## trade_events / plan_changes / genome

* `trade_events(id, trade_id, ts, event_type, payload_json)` + `idx_trade_events_trade_id`,
  `idx_trade_events_ts` — append-only forensic log, best-effort writes.
* `plan_changes(id, ts INTEGER, user_id, old_plan, new_plan, actor, reason)` +
  `idx_plan_changes_ts (ts DESC)`, `idx_plan_changes_uid` — every `sub_plan` mutation
  (`actor[:64]`, `reason[:256]`, no-op when old == new). v12 writes
  `actor='system:migration_v12'` rows for the D1 remap.
* `genome_population`, `genome_history` (`UNIQUE(strategy, timeframe, generation)`),
  `optimizer_params` (`PRIMARY KEY(user_id, strategy)`, `params` JSON) with the bot's
  three indexes (`idx_genome_strat_tf_gen`, `idx_genome_fitness`, `idx_genome_hist_strat`).

## What v12 did to the site's own data

* Exported to `data/backups/legacy-<ts>.json` (or `$LEGACY_BACKUP_DIR`), only when at
  least one legacy table had rows: `trading_bots`, `trades`, `trade_fills`, `signals`,
  `signal_registry`, `signal_views`, `user_signal_prefs`, `backtests`,
  `backtest_trades`, `optimizations`, `copy_subscriptions`, `published_strategies`,
  `strategy_installs`, `strategy_earnings`, `wallets`, `wallet_transactions`, plus the
  per-user values of `users.paper_starting_balance` / `users.public_profile`. Then
  all of them were dropped (`models/database.js` no longer creates them).
* `subscriptions` (decision D1): `elite` / `beginner` → `pro`; `starter` with
  `status='active'` and a future `expires_at` → `pro` until that date (the normal
  expiry check then downgrades to `free`); any other `starter` → `free`. Pending
  `payments` and `promo_codes` on a retired paid id → `pro`; confirmed payments are
  left as history.
* No per-bot → per-user mapping exists (a bot was pair × strategy × timeframe; the
  bot's user runs strategies × directions × TF over the whole universe), so every
  user starts from the defaults with `onboarding_done = 0` (`lang` from
  `users.locale`). The v9 "CHM Public Signals" system bot went with `trading_bots`;
  its non-loginable system user row (`system@chmup.top`) is left in place.

## The engine worker: scheduler, scanners, delivery (M9)

`workers/engineWorker.js` runs the signal engine off the HTTP thread (`ENGINE_WORKER=1`,
default on in production, never under tests): `startEngine()` in `server.js` spawns the
worker and supervises it with the bot's `_guarded_restart` backoff; the worker runs the
`worker` side of `scheduler.js` (the bot.py `main()` loops in gather order, timings pinned by
the PY311 trace in `tests/engine/worker/scheduler.timing.test.js`), the main thread runs the
`main` side (ghost cleanup, Genome maintenance and evolution) and answers the worker's
delivery RPCs (`signalDelivery.js`).

### The three scanners as bot.py starts them

`scanners/index.js` resolves the modules by the bot's names; the scheduler hands each the
thread's wiring (`ctx.scannerDeps(S)`):

| bot.py | site |
|---|---|
| `MidScanner(config, bot, um, stop_event=_stop_event)`; `scanner._health = health` | `new MidScanner(botConfig(env), ctx.bot, um, stopEvent, scannerDeps('LEVELS'))`; `StopEvent.isSet()` ends its loops |
| `scanner.fetcher = make_fetcher()`, used by every loop | the thread's BingX REST client (`bingxRest.getRest()`) + `getGlobalTrend` (`marketData/globalTrend` over the trend monitor's confirmed BTC state) = `ctx.fetcher()` |
| `run_volume_scanner(bot, um, scanner.fetcher, health=health)` | `runVolumeScanner(ctx.bot, um, fetcher, {health, signal, deps: scannerDeps('VOLUME')})`, which configures the module instance (the one `cache_gc` and the settings API use) |
| `run_smc_scanner(bot, um, scanner.fetcher, health=health)` | `runSmcScanner(ctx.bot, um, fetcher, {health, signal, deps})` |
| `ws_feed.register_on_bar_close(cb)` | `marketData/bingxWsFeed.registerOnBarClose`; one stable callback per scanner, so a restart does not add a second one (bound-method equality in the bot) |
| `asyncio.sleep`, `time.time` | the scheduler's abortable sleep and clock |
| `candle_store` + `HistoryLoader` (LEVELS warm-up) | `marketData/candleStore` |
| `execute_auto_trade`, the user's API keys | `deps.autoTrade` (M13b); until then none: no keys, so no trade and no counter-trend notice, for all three scanners |

### What a Telegram call becomes

| bot | site (`signalDelivery.js`) |
|---|---|
| SMC `safe_send_message(card / preview / notice)` | `deliver({kind, …})` → bool |
| LEVELS / VOLUME `safe_send_message(bot, uid, text, …)` | the bot's function (`levelsScanner.safeSendMessage`: split > 4096, retries, error classes) over `bot.sendMessage(uid, text, kw)` → the Message `{message_id = notifications.id, html, actions, lang}`, or an error named `TelegramForbiddenError` (deleted / inactive user), `TelegramBadRequest` or `TelegramNetworkError` (RPC not answered) |
| `on_sent=remember_signal_message(trade_id)` | `scheduler.siteRememberSignalMessage(trade_id)` marks the message as that trade's card (`kw.site.tradeId`); the main thread stores `signal_msg_id` + the card snapshot (strategy / symbol / direction from the row) |
| the other LEVELS / VOLUME messages | notices: `siteType: 'trade'` for the auto-trade notices (counter-trend, limit), `report` for the rest (hints, back-fill, expiry) |
| `send_signal_chart_bg` | `scheduler.siteSendChart` → a `deliverChart` descriptor (D3: the client draws it); the trade id from the signal's row; < 10 bars skipped |
| `bot.send_message(uid, …)` (trend, evening report) / admin alerts | `sendText` / `alertAdmins` |

`disable_notification` (quiet hours) → `silent`: in-app + SSE only (notifier, M10a).

### Shutdown = the bot's task cancellation

`scheduler.stop()` sets the stop event and aborts every loop (bot.py cancels the gather
tasks), waits ≤ 4 s, then force-saves the signal registry. A running cycle gets the bot's
`CancelledError` at its next checkpoint: LEVELS (between steps and symbols; re-raised past
"Ошибка цикла"; the [NOT-DELIVERED] path marks an undelivered row SKIP), VOLUME (between
symbols; "Volume scanner stopped."), SMC (after the per-symbol pause; "SMC Scanner stopped." +
re-raise, [SMC-RESTART-ON-STOP]). A loop stopped while it waits ends at once and silently
(the bot's `wait_for` sits outside the `try`). Pinned by
`tests/engine/worker/scannerWiring.test.js` and `engine.stop.integration.test.js`.

### Tests and fixtures

| test | what | regenerate |
|---|---|---|
| `tests/engine/scanners/levels_scan.test.js` | LEVELS `MidScanner._cycle()` replay, 12 cycles, 15 users | `py/levels_scan.py` |
| `tests/engine/scanners/levels_units.test.js` | LEVELS unit vectors (jobs, safe_send, WS trigger, scan loop, hint throttle …) | `py/levels_units.py` |
| `tests/engine/scanners/volume_scan.test.js`, `volume_units.test.js` | VOLUME `_scan_cycle` replay, unit vectors | `py/volume_scan.py`, `py/volume_units.py` |
| `tests/engine/scanners/smcScanner.diff.test.js` | SMC `_scan_cycle` + `_send_smc_card_bg` replay | `gen/gen_smc_scanner.py` |
| `tests/engine/worker/scheduler.timing.test.js` | bot.py loop instants over 6 simulated hours | `gen/gen_scheduler_trace.py` |
| `tests/engine/worker/engine.integration.test.js` | the worker with the three real scanners over a 1h and a 4h close (golden candles) | — |
| `tests/engine/worker/engine.stop.integration.test.js` | a stop in the middle of those cycles | — |

Every Python generator runs the bot's own code with CPython 3.11 from the bot checkout
(read-only): `cd <bot> && PYTHONDONTWRITEBYTECODE=1 BOT_TOKEN_CHM=test:token ADMIN_IDS=123
<py311> <site>/backend/tests/engine/…/<generator>`, then `rm -f <bot>/signal_registry.json`.
