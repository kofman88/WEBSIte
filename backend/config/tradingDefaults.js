/**
 * CHM Finance — Trading Defaults
 * Ported from Python CHM_BREAKER_V4/config.py
 *
 * All default trading parameters for new users.
 * These match the production Telegram bot exactly.
 */

module.exports = {
  // ═══════════════════════════════════════════════════
  //  LEVELS Strategy Defaults
  // ═══════════════════════════════════════════════════
  D_TIMEFRAME:    '1h',
  D_INTERVAL:     3600,
  D_PIVOT:        7,        // Pivot strength (bars on each side)
  D_ATR_PERIOD:   14,
  D_ATR_MULT:     1.0,
  D_MAX_RISK:     1.5,      // Max risk % per trade
  D_EMA_FAST:     50,
  D_EMA_SLOW:     200,
  D_RSI_PERIOD:   14,
  D_RSI_OB:       65,       // RSI overbought
  D_RSI_OS:       35,       // RSI oversold
  D_VOL_MULT:     1.0,
  D_VOL_LEN:      20,
  D_LEVEL_AGE:    100,      // Max bars since level was created
  D_RETEST_BARS:  30,       // Recent retest emphasis window
  D_COOLDOWN:     5,        // Min bars between signals
  D_ZONE_BUF:     0.3,
  D_ZONE_PCT:     0.7,      // Zone width % of price
  D_MAX_DIST_PCT: 1.5,      // Max distance to level %
  D_MIN_RR:       2.0,      // Minimum R:R (strict protocol)
  D_MAX_TESTS:    4,        // Max level tests before skip
  D_TP1:          2.0,      // TP1 R:R fallback
  D_TP2:          3.0,      // TP2 R:R fallback
  D_TP3:          4.5,      // TP3 R:R fallback
  D_HTF_EMA:      50,
  D_MIN_QUALITY:  4,        // Min quality 4/10
  D_MIN_VOL_USDT: 1_000_000,
  D_USE_RSI:      true,
  D_USE_VOLUME:   true,
  D_USE_PATTERN:  true,
  D_USE_HTF:      true,
  D_NOTIFY_SIG:   true,
  D_NOTIFY_BRK:   false,

  // ═══════════════════════════════════════════════════
  //  SMC Strategy Defaults
  // ═══════════════════════════════════════════════════
  SMC: {
    minConfirmations: 2,     // Min confirmations for entry
    minRR:            1.5,
    obMaxAge:         60,    // Order Block max age (bars) — V4: was 80
    obMinImpulse:     0.15,  // OB min impulse % — V4: was 0.1
    fvgMinGap:        0.08,  // Fair Value Gap min % — V4: new
    slBuffer:         0.5,   // SL buffer %
    swingLookback:    10,
    obBodyMult:       1.8,   // OB body multiplier
    useFVG:           true,
    useCHoCH:         true,
    useBOS:           true,
    mitigatedInvalid: true,  // V4: Mitigated OB = invalid
  },

  // ═══════════════════════════════════════════════════
  //  GERCHIK Strategy Defaults
  // ═══════════════════════════════════════════════════
  GERCHIK: {
    tp1R:             3.0,
    tp2R:             4.0,
    minRR:            2.5,
    pivotStrength:    5,
    lookback:         50,
    buffer:           0.20,  // Buffer %
    useBSU:           true,  // Bar Setup (BSU → BPU-1 → BPU-2)
    useLimitLevel:    false,
    mirrorLevelBonus: 3,     // V4: was 5
    clusterTolerance: 0.3,   // % to merge nearby levels
    maxDailyLosses:   3,     // Pause after N losses
    sessionFilter:    false, // 08:00-22:00 UTC
    atrFloor:         0.3,   // Min ATR for SL — V4: configurable
    volumeOnBPU:      true,  // V4: check volume on BPU bars
    emaFilterOptional:true,  // V4: EMA trend filter optional
  },

  // ═══════════════════════════════════════════════════
  //  SCALPING V3 Strategy Defaults
  // ═══════════════════════════════════════════════════
  SCALPING: {
    macdFast:        12,
    macdSlow:        26,
    macdSignal:      9,
    rsiPeriod:       14,
    rsiOB:           55,
    rsiOS:           45,
    volMult:         0.9,    // Volume spike multiplier
    atrMult:         1.2,    // ATR multiplier for SL
    useVolFilter:    true,
    useMACDCross:    true,
    useRSIFilter:    true,
    // V4 additions:
    vwapWindow:      24,     // VWAP rolling window (hours)
    volSpikeMult:    2.5,    // Volume spike threshold
    trendOnly:       false,  // Only trade with trend (EMA)
    htfTrendFilter:  false,  // Higher timeframe trend filter
    bodyPctFilter:   0.55,   // Min body % for Liquidity Grab
    // Entry methods:
    useVWAPBounce:   true,
    useLiquidityGrab:true,
    useVolSpike:     true,
  },

  // ═══════════════════════════════════════════════════
  //  Signal Filters (V4 Smart Filters)
  // ═══════════════════════════════════════════════════
  FILTERS: {
    fundingRateMax:     0.001,   // 0.1% — block LONG above, SHORT below
    spreadMax:          0.003,   // 0.3% — block if spread wider
    stalenessMaxPct:    2.0,     // 2% — block if price moved too far
    btcCorrelation:     false,   // BTC correlation block (off by default)
    cooldownBars:       5,       // Min bars between signals for same pair
  },

  // ═══════════════════════════════════════════════════
  //  Momentum Detector (V4)
  // ═══════════════════════════════════════════════════
  MOMENTUM: {
    checkIntervalMin:  5,        // Check every N minutes
    triggerPct:        2.0,      // BTC/ETH move % to trigger
    relaxedDurationMin:30,       // Relaxed mode duration
    // Relaxed mode overrides:
    relaxed: {
      levels_minQuality:   2,    // Normal: 4
      levels_minRR:        1.5,  // Normal: 2.0
      smc_minConfirmations:2,    // Normal: 3 (Note: default already 2)
      scalping_volSpikeMult:1.75,// Normal: 2.5
    },
    // ATR Breakout signal params:
    atrBreakout: {
      atrMult:       2.0,       // Candle > 2x ATR
      volMult:       1.5,       // Volume > 1.5x average
      slBuffer:      0.3,       // ATR buffer for SL
      tp1Mult:       2.0,       // TP1 = 2x ATR
      tp2Mult:       3.0,
      tp3Mult:       4.0,
      minRR:         2.0,
    },
  },

  // ═══════════════════════════════════════════════════
  //  Market Regime
  // ═══════════════════════════════════════════════════
  REGIME: {
    emaPeriod:       50,         // EMA for trend detection
    atrPeriod:       14,
    trendingThreshold:0.001,     // EMA slope > 0.1% = trending
    highVolThreshold: 1.5,       // ATR/price > 1.5x avg = high vol
    cacheTTLMin:      240,       // 4 hours cache
  },

  // ═══════════════════════════════════════════════════
  //  Partial Take Profit
  // ═══════════════════════════════════════════════════
  PARTIAL_TP: {
    enabled:        false,       // Off by default
    tp1Pct:         0.40,        // 40% of qty at TP1
    tp2Pct:         0.30,        // 30% of qty at TP2
    // Remaining 30% stays for final TP/trailing
    tp1R:           1.0,         // TP1 at 1.0R
    tp2R:           1.5,         // TP2 at 1.5R
    minNotional:    5.0,         // Min $5 per leg
  },

  // ═══════════════════════════════════════════════════
  //  Trailing Stop (V4 Hybrid)
  // ═══════════════════════════════════════════════════
  TRAILING: {
    enabled:        true,
    atrMult:        1.2,         // ATR distance from mark price
    // Step floors (SL never goes below these):
    steps: [
      { triggerR: 1.0, floorR: 0.0 },  // At +1R → SL at BE
      { triggerR: 2.0, floorR: 1.0 },  // At +2R → SL at +1R
      { triggerR: 3.0, floorR: 2.0 },  // At +3R → SL at +2R
    ],
  },

  // ═══════════════════════════════════════════════════
  //  Circuit Breaker
  // ═══════════════════════════════════════════════════
  CIRCUIT_BREAKER: {
    dailyMaxLossR:  0,           // 0 = disabled. Set to e.g. 10 for -10R daily limit
  },

  // ═══════════════════════════════════════════════════
  //  Entry Optimization (V4)
  // ═══════════════════════════════════════════════════
  ENTRY: {
    optimizePct:    0.0005,      // 0.05% better entry (limit order offset)
    useLimitOrder:  true,        // Use limit instead of market for entry
  },

  // ═══════════════════════════════════════════════════
  //  Performance / Scanner
  // ═══════════════════════════════════════════════════
  SCANNER: {
    scanIntervalSec: 30,         // Main scan loop interval
    maxSymbols:      20,         // Coins to scan
    chunkSize:       12,         // API requests per batch
    cacheTTL: {
      '1m':  55,    '5m':  270,   '15m': 870,
      '30m': 1770,  '1h':  3570,  '4h':  14370,
      '1d':  85000,
    },
  },

  // ═══════════════════════════════════════════════════
  //  Coins
  // ═══════════════════════════════════════════════════
  COINS: [
    'BTC','ETH','SOL','XRP','DOGE','BNB','ADA','AVAX','LINK','NEAR',
    'SUI','INJ','ARB','OP','APT','DOT','MATIC','UNI','LTC','ATOM',
  ],

  // ═══════════════════════════════════════════════════
  //  Exchange-specific
  // ═══════════════════════════════════════════════════
  EXCHANGE: {
    defaultLeverage:  10,
    defaultMarginMode:'cross',
    commissions: {
      bybit:   { maker: 0.02, taker: 0.055 },
      binance: { maker: 0.02, taker: 0.04  },
      bingx:   { maker: 0.02, taker: 0.05  },
      okx:     { maker: 0.02, taker: 0.05  },
    },
  },

  // ═══════════════════════════════════════════════════
  //  Plan Features (matches Python PLAN_FEATURES)
  // ═══════════════════════════════════════════════════
  PLAN_FEATURES: {
    free: {
      strategies:      ['LEVELS'],
      maxSignalsPerDay: 3,
      maxBots:          1,
      autoTrade:        false,
      backtest:         false,
      optimizer:        false,
    },
    starter: {
      strategies:      ['LEVELS','SCALPING'],
      maxSignalsPerDay: 999,
      maxBots:          3,
      autoTrade:        false,
      backtest:         false,
      optimizer:        false,
    },
    pro: {
      strategies:      ['LEVELS','SMC','GERCHIK','SCALPING'],
      maxSignalsPerDay: 999,
      maxBots:          10,
      autoTrade:        true,
      backtest:         true,
      optimizer:        false,
    },
    elite: {
      strategies:      ['LEVELS','SMC','GERCHIK','SCALPING'],
      maxSignalsPerDay: 999,
      maxBots:          999,
      autoTrade:        true,
      backtest:         true,
      optimizer:        true,
    },
  },
};
