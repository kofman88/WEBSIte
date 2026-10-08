
  CREATE TABLE IF NOT EXISTS trades (
    trade_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    entry REAL NOT NULL,
    sl REAL NOT NULL,
    tp1 REAL NOT NULL,
    tp2 REAL NOT NULL,
    tp3 REAL NOT NULL,
    tp1_rr REAL DEFAULT 0.8,
    tp2_rr REAL DEFAULT 1.5,
    tp3_rr REAL DEFAULT 2.5,
    quality INTEGER DEFAULT 1,
    timeframe TEXT DEFAULT '1h',
    breakout_type TEXT DEFAULT '',
    result TEXT DEFAULT '',
    result_rr REAL DEFAULT 0,
    created_at REAL DEFAULT 0,
    trail_level INTEGER DEFAULT 0,
    order_id TEXT DEFAULT '',
    be_set INTEGER DEFAULT 0,
    tp_placed INTEGER DEFAULT 0,
    risk_pct REAL DEFAULT 1.5,
    pos_idx INTEGER DEFAULT 0,
    leverage INTEGER DEFAULT 1,
    strategy TEXT DEFAULT '',
    copied_from INTEGER DEFAULT 0,
    state TEXT DEFAULT 'OPEN',
    state_changed_at REAL DEFAULT 0,
    placement_attempts INTEGER DEFAULT 0,
    closed_pnl_usd REAL DEFAULT NULL,
    qty REAL DEFAULT 0,
    original_sl REAL DEFAULT NULL,
    order_link_id TEXT DEFAULT '',
    signal_type TEXT DEFAULT '',
    skip_reason TEXT DEFAULT '',
    entry_lo REAL DEFAULT 0,
    entry_hi REAL DEFAULT 0,
    exchange TEXT DEFAULT 'bybit',
    tp_retry_count INTEGER DEFAULT 0,
    rsi REAL DEFAULT 50.0,
    volume_ratio REAL DEFAULT 1.0,
    is_counter_trend INTEGER DEFAULT 0,
    mtf_aligned INTEGER DEFAULT 0,
    trend_ctx TEXT DEFAULT '',
    btc_corr REAL DEFAULT 0.0,
    session TEXT DEFAULT '',
    preset_name TEXT DEFAULT NULL,
    ai_filter_json TEXT DEFAULT NULL,
    signal_msg_id INTEGER DEFAULT 0,
    progress_stage TEXT DEFAULT '',
    progress_ts REAL DEFAULT 0,
    signal_card_json TEXT DEFAULT '',
    expire_rr REAL DEFAULT NULL,
    user_note TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_bot_trades_user ON trades(user_id);
  CREATE INDEX IF NOT EXISTS idx_bot_trades_user_status ON trades(user_id, result);
  CREATE INDEX IF NOT EXISTS idx_bot_trades_user_created ON trades(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_bot_trades_symbol ON trades(user_id, symbol, result);
  CREATE INDEX IF NOT EXISTS idx_bot_trades_user_open ON trades(user_id, result, created_at);
  CREATE INDEX IF NOT EXISTS idx_bot_trades_result_all ON trades(result, created_at);
  CREATE INDEX IF NOT EXISTS idx_bot_trades_result_created ON trades(result, created_at);
  CREATE INDEX IF NOT EXISTS idx_bot_trades_user_order ON trades(user_id, order_id);
  CREATE INDEX IF NOT EXISTS idx_bot_trades_open_orders ON trades(result, order_id) WHERE result='';
  CREATE INDEX IF NOT EXISTS idx_bot_trades_state ON trades(state, state_changed_at);
  CREATE INDEX IF NOT EXISTS idx_bot_trades_signal_progress ON trades(created_at) WHERE signal_msg_id > 0;
  

  -- [FORENSICS] append-only timeline per trade (bot trade_events, verbatim).
  CREATE TABLE IF NOT EXISTS trade_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id      TEXT    NOT NULL,
    ts            REAL    NOT NULL,
    event_type    TEXT    NOT NULL,
    payload_json  TEXT    DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_trade_events_trade_id ON trade_events(trade_id);
  CREATE INDEX IF NOT EXISTS idx_trade_events_ts ON trade_events(ts);


  -- bot kv, verbatim namespace (volume_cfg_<uid>, challenge_<uid>, trend_state_v1,
  -- idemp_v1_*, zb_cooldown_*, analyze_count_<uid>_<day>, free_*, genome_*, …).
  -- Separate from system_kv so the bot's keys import 1:1.
  CREATE TABLE IF NOT EXISTS kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at REAL NOT NULL DEFAULT 0
  );

