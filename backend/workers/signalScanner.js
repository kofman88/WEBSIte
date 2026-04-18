/**
 * Signal scanner — periodic loop that runs each active bot's strategy
 * against freshly-fetched candles, stores new signals, and broadcasts
 * them via WebSocket.
 *
 * Runs in two modes:
 *   1. Child worker_thread (production) — spawned from server.js. The
 *      parent receives every new signal via postMessage so the parent
 *      can call websocketService.broadcastSignal() in the main thread.
 *   2. Standalone process (dev: `node workers/signalScanner.js`) — same
 *      code path but logs directly and doesn't broadcast (or you can
 *      wire in an in-process broadcaster via an optional CLI flag).
 *
 * Per-cycle flow (every SCAN_INTERVAL_MS):
 *   - Fetch all active bots (trading_bots.is_active = 1)
 *   - For each bot:
 *       - Respect rate limits (p-queue concurrency 3 per exchange)
 *       - fetchCandles(bot.exchange, each-symbol, bot.timeframe, 300 bars)
 *       - strategies[bot.strategy].scan(candles, bot.strategy_config)
 *       - If signal:
 *           - signalService.insert() handles dedup + DB write
 *           - If auto_trade & plan allows → enqueue autoTradeService (P10)
 *           - Report to parent thread for broadcast
 *   - Update bot.last_run_at
 *
 * Expected cadence: 15-30 seconds on 1m, 1-2 min on 1h, 5 min on 4h.
 *
 * Graceful shutdown: listen SIGTERM and worker_thread's "stop" message.
 */

const { parentPort, isMainThread } = require('worker_threads');
const PQueue = require('p-queue').default;
const db = require('../models/database');
const marketData = require('../services/marketDataService');
const signalService = require('../services/signalService');
const registry = require('../services/signalRegistry');
const logger = require('../utils/logger');
const config = require('../config');

const levels = require('../strategies/levels');

// Strategy registry — add new strategies here as they land (Phase 8).
const STRATEGIES = {
  levels: levels,
  // smc:      require('../strategies/smc'),
  // gerchik:  require('../strategies/gerchik'),
  // scalping: require('../strategies/scalping'),
};

const SCAN_INTERVAL_MS = parseInt(process.env.SCANNER_INTERVAL_MS, 10) || 60_000; // 60s default
const EXCHANGE_CONCURRENCY = 3;

const queues = new Map(); // exchange → PQueue
function getQueue(exchange) {
  if (!queues.has(exchange)) queues.set(exchange, new PQueue({ concurrency: EXCHANGE_CONCURRENCY }));
  return queues.get(exchange);
}

let running = false;
let stopRequested = false;
let loopTimer = null;

async function runCycle() {
  if (running || stopRequested) return;
  running = true;
  const cycleStart = Date.now();

  try {
    const bots = db.prepare(`
      SELECT * FROM trading_bots WHERE is_active = 1
    `).all();

    if (bots.length === 0) {
      logger.debug('scanner: no active bots');
      return;
    }

    logger.debug('scanner cycle', { bots: bots.length });
    let signalsProduced = 0;

    for (const bot of bots) {
      const strat = STRATEGIES[bot.strategy];
      if (!strat) {
        logger.warn('unknown strategy', { botId: bot.id, strategy: bot.strategy });
        continue;
      }

      let symbols;
      try { symbols = JSON.parse(bot.symbols || '[]'); } catch { symbols = []; }
      if (!Array.isArray(symbols) || !symbols.length) continue;

      const cfg = bot.strategy_config ? safeJson(bot.strategy_config, {}) : {};

      for (const symbol of symbols) {
        const q = getQueue(bot.exchange);
        q.add(async () => {
          try {
            const candles = await marketData.fetchCandles(
              bot.exchange, symbol, bot.timeframe, { limit: 300 }
            );
            if (!candles || candles.length < 50) return;

            const sig = strat.scan(candles, cfg);
            if (!sig) return;

            // Directional filter
            if (bot.direction && bot.direction !== 'both' && sig.side !== bot.direction) {
              return;
            }

            // Persist + dedup
            const saved = signalService.insert({
              userId: bot.user_id,
              botId: bot.id,
              exchange: bot.exchange,
              symbol,
              strategy: sig.strategy,
              timeframe: bot.timeframe,
              side: sig.side,
              entry: sig.entry,
              stopLoss: sig.stopLoss,
              tp1: sig.tp1,
              tp2: sig.tp2,
              tp3: sig.tp3,
              riskReward: sig.riskReward,
              confidence: sig.confidence,
              quality: sig.quality,
              reason: sig.reason,
              metadata: sig.metadata,
              expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
            });

            if (!saved) return; // dup
            signalsProduced++;

            logger.info('signal produced', {
              id: saved.id, bot: bot.id, strategy: saved.strategy,
              symbol: saved.symbol, side: saved.side, quality: saved.quality,
            });

            // Notify parent thread for WebSocket broadcast
            if (parentPort) {
              parentPort.postMessage({ type: 'signal', signal: saved, botId: bot.id });
            }

            // Auto-trade hook — Phase 10 will plug here
            if (bot.auto_trade) {
              if (parentPort) {
                parentPort.postMessage({ type: 'auto_trade_request', signal: saved, botId: bot.id });
              }
            }
          } catch (err) {
            logger.warn('scan error', {
              botId: bot.id, symbol, err: err.message,
            });
          }
        });
      }

      db.prepare('UPDATE trading_bots SET last_run_at = CURRENT_TIMESTAMP WHERE id = ?').run(bot.id);
    }

    // Wait for all queues to drain (but cap wait to SCAN_INTERVAL)
    const drainPromises = [];
    for (const q of queues.values()) drainPromises.push(q.onIdle());
    await Promise.race([
      Promise.all(drainPromises),
      new Promise((r) => setTimeout(r, SCAN_INTERVAL_MS - 2000)),
    ]);

    // Dedup cleanup every cycle
    const cleaned = registry.cleanupExpired();
    if (cleaned > 0) logger.debug('registry cleanup', { removed: cleaned });

    logger.info('cycle done', {
      bots: bots.length,
      signals: signalsProduced,
      durationMs: Date.now() - cycleStart,
    });
  } catch (err) {
    logger.error('scanner cycle error', { err: err.message, stack: err.stack });
  } finally {
    running = false;
  }
}

function startLoop() {
  if (loopTimer) return;
  logger.info('scanner loop started', { intervalMs: SCAN_INTERVAL_MS });
  // Kick off immediately then set interval
  runCycle().catch((e) => logger.error('kickoff failed', { err: e.message }));
  loopTimer = setInterval(() => {
    if (stopRequested) return;
    runCycle().catch((e) => logger.error('cycle failed', { err: e.message }));
  }, SCAN_INTERVAL_MS);
}

function stopLoop() {
  stopRequested = true;
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
  logger.info('scanner stop requested');
}

function safeJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// ── Bootstrap ─────────────────────────────────────────────────────────
if (parentPort) {
  // Running as worker_thread
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'stop') {
      stopLoop();
      parentPort.postMessage({ type: 'stopped' });
    }
  });
  startLoop();
} else if (require.main === module) {
  // Running standalone (`node workers/signalScanner.js`)
  process.on('SIGTERM', () => { stopLoop(); setTimeout(() => process.exit(0), 1500); });
  process.on('SIGINT',  () => { stopLoop(); setTimeout(() => process.exit(0), 1500); });
  startLoop();
}

module.exports = { runCycle, startLoop, stopLoop, STRATEGIES };
