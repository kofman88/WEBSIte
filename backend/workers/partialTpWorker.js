/**
 * Partial-TP / SL worker — periodically scans all open trades, fills
 * partial TPs and stops, and forwards close events back to the parent
 * process so the parent's WebSocket server can broadcast to the user.
 *
 * Why a worker_thread (not just an in-process setInterval):
 *   - tickOpen() loops over every open trade and fetches candles +
 *     does a few synchronous DB writes per iteration. With 1000+ open
 *     trades this can pin the main thread for hundreds of ms once a
 *     minute, jittering API latency for unrelated requests.
 *   - In a worker thread the heavy work lives off the request/response
 *     event loop. Parent stays responsive.
 *
 * IPC:
 *   - { type: 'trade_closed', userId, data, ts } — emitted from
 *     partialTpManager._closeTrade via the onClose hook installed
 *     below. Parent listens and broadcasts via websocketService.
 *   - { type: 'tick', closed } — periodic heartbeat for log/health.
 *
 * Graceful shutdown: parent posts { type: 'stop' }; we drain the
 * current tick, post { type: 'stopped' }, and exit.
 */

const { parentPort } = require('worker_threads');
const partialTpManager = require('../services/partialTpManager');
const marketDataService = require('../services/marketDataService');
const exchangeService = require('../services/exchangeService');
const logger = require('../utils/logger');

const TICK_MS = Number(process.env.PARTIAL_TP_INTERVAL_MS) || 60_000;

let stopRequested = false;
let timer = null;

function postClose(event) {
  if (parentPort) parentPort.postMessage(event);
}

partialTpManager.init({
  marketData: marketDataService,
  exchangeService,
  onClose: postClose,
});

async function tickSafe() {
  try {
    const r = await partialTpManager.tickOpen();
    if (parentPort && r && (r.closed > 0 || r.processed > 0)) {
      parentPort.postMessage({ type: 'tick', closed: r.closed, processed: r.processed });
    }
  } catch (err) {
    logger.error('partialTp worker tick error', { err: err.message });
  }
}

function startLoop() {
  // Fire immediately on boot so a freshly-restarted process doesn't
  // wait a full TICK_MS before catching SL hits that happened during
  // downtime.
  tickSafe();
  timer = setInterval(() => {
    if (stopRequested) return;
    tickSafe();
  }, TICK_MS);
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'stop') {
      stopRequested = true;
      if (timer) { clearInterval(timer); timer = null; }
      parentPort.postMessage({ type: 'stopped' });
    }
  });
  startLoop();
} else if (require.main === module) {
  // Standalone mode for dev: `node workers/partialTpWorker.js`
  process.on('SIGTERM', () => { stopRequested = true; if (timer) clearInterval(timer); setTimeout(() => process.exit(0), 1000); });
  process.on('SIGINT',  () => { stopRequested = true; if (timer) clearInterval(timer); setTimeout(() => process.exit(0), 1000); });
  startLoop();
}

module.exports = { _tickSafe: tickSafe };
