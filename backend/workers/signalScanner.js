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
const smc = require('../strategies/smc');
const scalping = require('../strategies/scalping');
const gerchik = require('../strategies/gerchik');
const dca = require('../strategies/dca');
const grid = require('../strategies/grid');

// Strategy registry — add new strategies here as they land.
const STRATEGIES = {
  levels,
  smc,
  scalping,
  gerchik,
  dca,
  grid,
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

    // Market-scope universe cache — per exchange, refreshed from marketDataService
    // which already has a 60-minute symbols cache, so calling this every cycle
    // is cheap (one in-memory read per exchange per cycle).
    const marketUniverseCache = new Map(); // exchange → [symbol…]
    async function getMarketUniverse(exchange) {
      if (marketUniverseCache.has(exchange)) return marketUniverseCache.get(exchange);
      try {
        const all = await marketData.fetchSymbols(exchange);
        // USDT-quoted, linear (perps), active — the trade-worthy universe
        const usdt = all
          .filter((m) => m.quote === 'USDT' && m.linear !== false && m.type !== 'option')
          .map((m) => m.symbol);
        marketUniverseCache.set(exchange, usdt);
        return usdt;
      } catch (e) {
        logger.warn('market universe fetch failed', { exchange, err: e.message });
        marketUniverseCache.set(exchange, []);
        return [];
      }
    }

    // Single signal-processing job — factored out so pair-scope and market-scope
    // can share it. Applies strategy, directional filter, persists + dedups,
    // and triggers WS broadcast + auto-trade hook.
    function enqueueScan({ exchange, symbol, strategies, cfg, bot }) {
      const q = getQueue(exchange);
      q.add(async () => {
        try {
          const candles = await marketData.fetchCandles(
            exchange, symbol, bot.timeframe, { limit: 300 }
          );
          if (!candles || candles.length < 50) return;

          for (const stratName of strategies) {
            const strat = STRATEGIES[stratName];
            if (!strat) continue;
            const sig = strat.scan(candles, cfg);
            if (!sig) continue;

            // Directional filter
            if (bot.direction && bot.direction !== 'both' && sig.side !== bot.direction) continue;

            const saved = signalService.insert({
              userId: bot.user_id,
              botId: bot.id,
              exchange,
              symbol,
              strategy: sig.strategy || stratName,
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

            if (!saved) continue; // dup across strategies / cycles
            signalsProduced++;

            logger.info('signal produced', {
              id: saved.id, bot: bot.id, strategy: saved.strategy,
              symbol: saved.symbol, side: saved.side, quality: saved.quality,
              scope: bot.scope || 'pair',
            });

            if (parentPort) {
              parentPort.postMessage({ type: 'signal', signal: saved, botId: bot.id });
              if (bot.auto_trade) {
                parentPort.postMessage({ type: 'auto_trade_request', signal: saved, botId: bot.id });
              }
            }
          }
        } catch (err) {
          logger.warn('scan error', { botId: bot.id, symbol, err: err.message });
        }
      });
    }

    for (const bot of bots) {
      const cfg = bot.strategy_config ? safeJson(bot.strategy_config, {}) : {};

      // Resolve which strategies to run — Elite multi-strategy combo wins
      // over the single `strategy` column if set.
      let strategies;
      const multi = safeJson(bot.strategies_multi, null);
      if (Array.isArray(multi) && multi.length > 0) {
        strategies = multi.filter((s) => STRATEGIES[s]);
        // Multi was set but none resolved → bot wouldn't produce signals at
        // all without a clear log. Surface it instead of silently skipping.
        if (strategies.length === 0) {
          logger.warn('multi-strategy contains no valid entries', {
            botId: bot.id, configured: multi, available: Object.keys(STRATEGIES),
          });
          continue;
        }
      } else if (bot.strategy && STRATEGIES[bot.strategy]) {
        strategies = [bot.strategy];
      } else {
        logger.warn('bot has no valid strategy', { botId: bot.id, strategy: bot.strategy, multi });
        continue;
      }

      if ((bot.scope || 'pair') === 'market') {
        // ── MARKET SCANNER ────────────────────────────────────────
        // Universe = USDT-linear pairs across every exchange selected.
        // Every pair × every strategy is enqueued; max_open_trades +
        // circuit breaker in autoTradeService cap the blast radius.
        const exchanges = safeJson(bot.market_exchanges, []);
        if (!Array.isArray(exchanges) || exchanges.length === 0) {
          logger.warn('market bot has no exchanges configured', { botId: bot.id });
          continue;
        }
        let pairCount = 0;
        for (const exchange of exchanges) {
          const universe = await getMarketUniverse(exchange);
          pairCount += universe.length;
          for (const symbol of universe) {
            enqueueScan({ exchange, symbol, strategies, cfg, bot });
          }
        }
        logger.info('market bot enqueued', {
          botId: bot.id, exchanges: exchanges.length,
          pairs: pairCount, strategies: strategies.length,
        });
      } else {
        // ── PAIR SCOPE (existing behavior) ────────────────────────
        let symbols;
        try { symbols = JSON.parse(bot.symbols || '[]'); } catch { symbols = []; }
        if (!Array.isArray(symbols) || !symbols.length) continue;

        for (const symbol of symbols) {
          enqueueScan({ exchange: bot.exchange, symbol, strategies, cfg, bot });
        }
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
