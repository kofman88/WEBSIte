const db = require('../models/database');

/**
 * Supported strategy types and their display labels.
 */
const STRATEGIES = {
  scalping: { id: 'scalping', name: 'Scalping', description: 'High-frequency short-term trades' },
  smc: { id: 'smc', name: 'Smart Money Concepts', description: 'Order-block / liquidity sweep setups' },
  gerchik: { id: 'gerchik', name: 'Gerchik Method', description: 'Level-based risk/reward approach' },
};

const VALID_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const VALID_DIRECTIONS = ['long', 'short'];

class SignalService {
  // ── Signal CRUD ────────────────────────────────────────────────────────

  /**
   * Create a new signal (admin / internal use).
   */
  createSignal(data) {
    const {
      symbol,
      direction,
      entryPrice,
      stopLoss,
      takeProfit1,
      takeProfit2,
      takeProfit3,
      strategy,
      timeframe,
      confidence,
      notes,
    } = data;

    // Validation
    if (!symbol || !direction || entryPrice == null || stopLoss == null || !strategy || !timeframe || confidence == null) {
      throw new Error('Missing required signal fields: symbol, direction, entryPrice, stopLoss, strategy, timeframe, confidence');
    }

    if (!VALID_DIRECTIONS.includes(direction)) {
      throw new Error(`Invalid direction "${direction}". Must be one of: ${VALID_DIRECTIONS.join(', ')}`);
    }
    if (!STRATEGIES[strategy]) {
      throw new Error(`Invalid strategy "${strategy}". Must be one of: ${Object.keys(STRATEGIES).join(', ')}`);
    }
    if (!VALID_TIMEFRAMES.includes(timeframe)) {
      throw new Error(`Invalid timeframe "${timeframe}". Must be one of: ${VALID_TIMEFRAMES.join(', ')}`);
    }
    if (confidence < 0 || confidence > 100) {
      throw new Error('Confidence must be between 0 and 100');
    }

    const stmt = db.prepare(`
      INSERT INTO signal_history (
        symbol, direction, entry_price, stop_loss,
        take_profit_1, take_profit_2, take_profit_3,
        strategy, timeframe, confidence, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      symbol.toUpperCase(),
      direction,
      entryPrice,
      stopLoss,
      takeProfit1 || null,
      takeProfit2 || null,
      takeProfit3 || null,
      strategy,
      timeframe,
      Math.round(confidence),
      notes || null
    );

    return this.getSignalById(result.lastInsertRowid);
  }

  /**
   * Get a single signal by ID.
   */
  getSignalById(signalId) {
    return db.prepare('SELECT * FROM signal_history WHERE id = ?').get(signalId);
  }

  /**
   * Fetch signals with pagination, filtering, and ordering.
   *
   * Options: { page, limit, strategy, symbol, direction, minConfidence, status }
   */
  getSignals(options = {}) {
    const {
      page = 1,
      limit = 20,
      strategy,
      symbol,
      direction,
      minConfidence,
      status,
    } = options;

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (safePage - 1) * safeLimit;

    const conditions = [];
    const params = [];

    if (strategy) {
      conditions.push('strategy = ?');
      params.push(strategy);
    }
    if (symbol) {
      conditions.push('symbol = ?');
      params.push(symbol.toUpperCase());
    }
    if (direction) {
      conditions.push('direction = ?');
      params.push(direction);
    }
    if (minConfidence != null) {
      conditions.push('confidence >= ?');
      params.push(parseInt(minConfidence, 10));
    }
    if (status) {
      conditions.push('result = ?');
      params.push(status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = db
      .prepare(`SELECT COUNT(*) as total FROM signal_history ${where}`)
      .get(...params);

    const signals = db
      .prepare(
        `SELECT * FROM signal_history ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, safeLimit, offset);

    return {
      signals,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: countRow.total,
        totalPages: Math.ceil(countRow.total / safeLimit),
      },
    };
  }

  /**
   * Get signals created after a certain ID (for real-time polling / SSE).
   */
  getSignalsSince(sinceId) {
    return db
      .prepare(
        `SELECT * FROM signal_history
         WHERE id > ?
         ORDER BY created_at ASC`
      )
      .all(sinceId || 0);
  }

  /**
   * Close a signal with a result.
   */
  closeSignal(signalId, { result, pnlPct }) {
    if (!['win', 'loss', 'breakeven', 'cancelled'].includes(result)) {
      throw new Error('result must be one of: win, loss, breakeven, cancelled');
    }

    db.prepare(
      `UPDATE signal_history
       SET result = ?, pnl_pct = ?, closed_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(result, pnlPct ?? null, signalId);

    return this.getSignalById(signalId);
  }

  // ── Performance stats ──────────────────────────────────────────────────

  /**
   * Aggregate signal performance statistics.
   */
  getStats(options = {}) {
    const { strategy, days } = options;
    const conditions = ["result != 'pending'"];
    const params = [];

    if (strategy) {
      conditions.push('strategy = ?');
      params.push(strategy);
    }
    if (days) {
      conditions.push("created_at >= datetime('now', ? || ' days')");
      params.push(-Math.abs(parseInt(days, 10)));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const total = db
      .prepare(`SELECT COUNT(*) as cnt FROM signal_history ${where}`)
      .get(...params).cnt;

    const wins = db
      .prepare(`SELECT COUNT(*) as cnt FROM signal_history ${where} AND result = 'win'`)
      .get(...params).cnt;

    const losses = db
      .prepare(`SELECT COUNT(*) as cnt FROM signal_history ${where} AND result = 'loss'`)
      .get(...params).cnt;

    const avgPnl = db
      .prepare(
        `SELECT AVG(pnl_pct) as avg_pnl FROM signal_history ${where} AND pnl_pct IS NOT NULL`
      )
      .get(...params).avg_pnl;

    const totalPnl = db
      .prepare(
        `SELECT SUM(pnl_pct) as total_pnl FROM signal_history ${where} AND pnl_pct IS NOT NULL`
      )
      .get(...params).total_pnl;

    const avgConfidence = db
      .prepare(`SELECT AVG(confidence) as avg_conf FROM signal_history ${where}`)
      .get(...params).avg_conf;

    // Per-strategy breakdown
    const byStrategy = db
      .prepare(
        `SELECT strategy,
                COUNT(*) as total,
                SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) as losses,
                AVG(pnl_pct) as avg_pnl
         FROM signal_history ${where}
         GROUP BY strategy`
      )
      .all(...params);

    return {
      total,
      wins,
      losses,
      breakeven: total - wins - losses,
      winRate: total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0',
      avgPnlPct: avgPnl != null ? avgPnl.toFixed(2) : '0.00',
      totalPnlPct: totalPnl != null ? totalPnl.toFixed(2) : '0.00',
      avgConfidence: avgConfidence != null ? avgConfidence.toFixed(1) : '0.0',
      byStrategy: byStrategy.map((s) => ({
        strategy: s.strategy,
        total: s.total,
        wins: s.wins,
        losses: s.losses,
        winRate: s.total > 0 ? ((s.wins / s.total) * 100).toFixed(1) : '0.0',
        avgPnlPct: s.avg_pnl != null ? s.avg_pnl.toFixed(2) : '0.00',
      })),
    };
  }

  // ── User signal preferences ────────────────────────────────────────────

  /**
   * Get or create a user's signal configuration.
   */
  getUserSignalConfig(userId) {
    let cfg = db
      .prepare('SELECT * FROM user_signals_config WHERE user_id = ?')
      .get(userId);

    if (!cfg) {
      db.prepare(
        `INSERT INTO user_signals_config (user_id) VALUES (?)`
      ).run(userId);
      cfg = db
        .prepare('SELECT * FROM user_signals_config WHERE user_id = ?')
        .get(userId);
    }

    return {
      ...cfg,
      strategies_enabled: JSON.parse(cfg.strategies_enabled || '[]'),
      pairs_filter: JSON.parse(cfg.pairs_filter || '[]'),
    };
  }

  /**
   * Update a user's signal configuration.
   */
  updateUserSignalConfig(userId, updates) {
    // Ensure row exists
    this.getUserSignalConfig(userId);

    const allowed = ['strategies_enabled', 'pairs_filter', 'min_confidence', 'notifications_enabled'];
    const setClauses = [];
    const values = [];

    if (updates.strategiesEnabled !== undefined) {
      if (!Array.isArray(updates.strategiesEnabled)) {
        throw new Error('strategiesEnabled must be an array');
      }
      const invalid = updates.strategiesEnabled.filter((s) => !STRATEGIES[s]);
      if (invalid.length > 0) {
        throw new Error(`Invalid strategies: ${invalid.join(', ')}`);
      }
      setClauses.push('strategies_enabled = ?');
      values.push(JSON.stringify(updates.strategiesEnabled));
    }

    if (updates.pairsFilter !== undefined) {
      if (!Array.isArray(updates.pairsFilter)) {
        throw new Error('pairsFilter must be an array');
      }
      setClauses.push('pairs_filter = ?');
      values.push(JSON.stringify(updates.pairsFilter));
    }

    if (updates.minConfidence !== undefined) {
      const mc = parseInt(updates.minConfidence, 10);
      if (isNaN(mc) || mc < 0 || mc > 100) {
        throw new Error('minConfidence must be between 0 and 100');
      }
      setClauses.push('min_confidence = ?');
      values.push(mc);
    }

    if (updates.notificationsEnabled !== undefined) {
      setClauses.push('notifications_enabled = ?');
      values.push(updates.notificationsEnabled ? 1 : 0);
    }

    if (setClauses.length === 0) {
      throw new Error('No valid fields to update');
    }

    values.push(userId);
    db.prepare(
      `UPDATE user_signals_config
       SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`
    ).run(...values);

    return this.getUserSignalConfig(userId);
  }

  /**
   * Get filtered signals for a specific user based on their config.
   */
  getFilteredSignalsForUser(userId, options = {}) {
    const cfg = this.getUserSignalConfig(userId);

    const mergedOptions = {
      ...options,
      minConfidence: options.minConfidence ?? cfg.min_confidence,
    };

    // Strategy filter
    if (cfg.strategies_enabled && cfg.strategies_enabled.length > 0 && !options.strategy) {
      // We'll filter in memory since SQLite IN clause is tricky with prepared statements
      const result = this.getSignals(mergedOptions);
      result.signals = result.signals.filter((s) =>
        cfg.strategies_enabled.includes(s.strategy)
      );
      // Pair filter
      if (cfg.pairs_filter && cfg.pairs_filter.length > 0) {
        result.signals = result.signals.filter((s) =>
          cfg.pairs_filter.includes(s.symbol)
        );
      }
      return result;
    }

    return this.getSignals(mergedOptions);
  }

  /**
   * Return available strategies metadata.
   */
  getStrategies() {
    return Object.values(STRATEGIES);
  }

  /**
   * Return valid timeframes.
   */
  getTimeframes() {
    return VALID_TIMEFRAMES;
  }
}

module.exports = new SignalService();
