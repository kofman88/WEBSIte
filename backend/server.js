const http = require('http');
const path = require('path');
const { Worker } = require('worker_threads');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const config = require('./config');
const logger = require('./utils/logger');

const authRoutes = require('./routes/auth');
const botsRoutes = require('./routes/bots');
const backtestsRoutes = require('./routes/backtests');
const exchangesRoutes = require('./routes/exchanges');
const subscriptionsRoutes = require('./routes/subscriptions');
const signalsRoutes = require('./routes/signals');
const walletRoutes = require('./routes/wallet');
const optimizationsRoutes = require('./routes/optimizations');
const paymentsRoutes = require('./routes/payments');
const websocketService = require('./services/websocketService');
const autoTradeService = require('./services/autoTradeService');
const partialTpManager = require('./services/partialTpManager');
const exchangeService = require('./services/exchangeService');
const marketDataService = require('./services/marketDataService');
const cryptoMonitor = require('./services/cryptoMonitor');
const db = require('./models/database');

const app = express();

// Trust proxy for correct req.ip behind Passenger / reverse proxy
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors({
  origin: config.corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(compression());

// Global per-IP rate-limit across /api (skipped in tests)
if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { error: 'Too many requests, please try again later', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/', globalLimiter);
}

// Stripe webhook needs RAW body for signature verification — mount raw
// parser ONLY for that specific path before the global JSON parser.
app.use('/api/payments/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }),
  (req, _res, next) => { req.rawBody = req.body; next(); });

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Request logging (skip static/health)
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/') && req.path !== '/api/health') {
    logger.debug('→ ' + req.method + ' ' + req.path);
  }
  next();
});

// ── API Routes ─────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/bots', botsRoutes);
app.use('/api/backtests', backtestsRoutes);
app.use('/api/exchanges', exchangesRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/api/signals', signalsRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/optimizations', optimizationsRoutes);
app.use('/api/payments', paymentsRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '3.0.0' });
});

// ── Static files (Passenger serves everything) ────────────────────────
const publicPath = path.join(require('os').homedir(), 'public_html');
app.use(express.static(publicPath));

// SPA fallback — non-API routes serve index.html
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(publicPath, 'index.html'));
  } else {
    res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' });
  }
});

// ── Error handlers ────────────────────────────────────────────────────
// Zod validation → 400
// Service errors with statusCode → that status
// Unknown → 500 (don't leak stack in prod)
app.use((err, req, res, _next) => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({
      error: err.message || 'Error',
      ...(err.code ? { code: err.code } : {}),
    });
  }
  logger.error('unhandled server error', {
    path: req.path,
    method: req.method,
    err: err && err.message,
    stack: err && err.stack,
  });
  res.status(500).json({
    error: config.isProd ? 'Internal server error' : (err && err.message) || 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
});

// ── Start: Passenger or standalone ────────────────────────────────────
const PORT = config.port || 3000;
const IS_TEST = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

// ── Scanner worker_thread (Phase 6) ──────────────────────────────────
let scannerWorker = null;
function startScannerWorker() {
  if (IS_TEST || process.env.SCANNER_DISABLED === '1') return;
  try {
    scannerWorker = new Worker(path.join(__dirname, 'workers', 'signalScanner.js'), {
      env: process.env,
    });
    scannerWorker.on('message', (msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'signal' && msg.signal) {
        try { websocketService.broadcastSignal(msg.signal); } catch (e) { /* */ }
      } else if (msg.type === 'auto_trade_request' && msg.signal) {
        // Phase 10 — load bot + route to autoTradeService
        (async () => {
          try {
            const bot = db.prepare('SELECT * FROM trading_bots WHERE id = ?').get(msg.botId);
            if (!bot || !bot.is_active || !bot.auto_trade) return;
            const trade = await autoTradeService.executeSignal(msg.signal, bot, {
              exchangeService, marketData: marketDataService,
            });
            if (trade) {
              try {
                websocketService.broadcastToUser(bot.user_id, {
                  type: 'trade_opened', data: trade, ts: Date.now(),
                });
              } catch (_e) { /* */ }
            }
          } catch (err) {
            logger.error('auto_trade_request failed', { err: err.message, botId: msg.botId });
          }
        })();
      } else if (msg.type === 'stopped') {
        logger.info('scanner worker stopped cleanly');
      }
    });
    scannerWorker.on('error', (err) => logger.error('scanner worker error', { err: err.message }));
    scannerWorker.on('exit', (code) => {
      logger.warn('scanner worker exited', { code });
      scannerWorker = null;
      if (code !== 0 && !scannerShutdownRequested) {
        // Auto-restart with backoff
        setTimeout(() => { if (!scannerShutdownRequested) startScannerWorker(); }, 5_000);
      }
    });
    logger.info('scanner worker started');
  } catch (err) {
    logger.error('failed to start scanner worker', { err: err.message });
  }
}

let scannerShutdownRequested = false;
async function stopScannerWorker() {
  scannerShutdownRequested = true;
  if (!scannerWorker) return;
  try {
    scannerWorker.postMessage({ type: 'stop' });
  } catch (_e) { /* */ }
  // Give it 3s to stop gracefully then terminate
  await new Promise((r) => setTimeout(r, 3000));
  try { scannerWorker.terminate(); } catch (_e) { /* */ }
  scannerWorker = null;
}

function shutdown(sig) {
  return async () => {
    logger.info('received ' + sig + ', shutting down');
    try { await stopScannerWorker(); } catch (e) { /* */ }
    try { websocketService.shutdown(); } catch (e) { /* */ }
    try { db.close(); } catch (e) { /* */ }
    process.exit(0);
  };
}

// Init partialTpManager with service refs
partialTpManager.init({ marketData: marketDataService, exchangeService });

// Cron: every 60s process open trades (paper TP/SL simulation)
let partialTpTimer = null;
function startPartialTpCron() {
  if (partialTpTimer) return;
  partialTpTimer = setInterval(() => {
    partialTpManager.tickOpen()
      .then((r) => { if (r.closed > 0) logger.debug('partialTp tick', r); })
      .catch((err) => logger.warn('partialTp tick error', { err: err.message }));
  }, 60_000);
}

if (IS_TEST) {
  // Test env — do not start HTTP listener, just export the app for supertest
} else if (typeof(PhusionPassenger) !== 'undefined') {
  app.listen('passenger', () => logger.info('CHM Finance running via Passenger'));
  startScannerWorker();
  startPartialTpCron();
  cryptoMonitor.start();
  process.on('SIGTERM', shutdown('SIGTERM'));
} else {
  const server = http.createServer(app);
  websocketService.init({ server });
  server.listen(PORT, () => logger.info('CHM Finance running on port ' + PORT));
  startScannerWorker();
  startPartialTpCron();
  cryptoMonitor.start();

  process.on('SIGTERM', () => { shutdown('SIGTERM')().then(() => server.close()); });
  process.on('SIGINT',  () => { shutdown('SIGINT')().then(() => server.close()); });
}

module.exports = app;
