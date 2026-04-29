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
const sentry = require('./utils/sentry');

const authRoutes = require('./routes/auth');
const botsRoutes = require('./routes/bots');
const backtestsRoutes = require('./routes/backtests');
const exchangesRoutes = require('./routes/exchanges');
const subscriptionsRoutes = require('./routes/subscriptions');
const signalsRoutes = require('./routes/signals');
const walletRoutes = require('./routes/wallet');
const optimizationsRoutes = require('./routes/optimizations');
const paymentsRoutes = require('./routes/payments');
const adminRoutes = require('./routes/admin');
const notificationsRoutes = require('./routes/notifications');
const telegramRoutes = require('./routes/telegram');
const analyticsRoutes = require('./routes/analytics');
const webhooksRoutes = require('./routes/webhooks');
const publicRoutes = require('./routes/public');
const supportRoutes = require('./routes/support');
const pushRoutes = require('./routes/push');
const copyRoutes = require('./routes/copy');
const strategyMarketRoutes = require('./routes/strategyMarket');
const riskRoutes = require('./routes/risk');
const aiRoutes = require('./routes/ai');
const websocketService = require('./services/websocketService');
const autoTradeService = require('./services/autoTradeService');
const partialTpManager = require('./services/partialTpManager');
const exchangeService = require('./services/exchangeService');
const marketDataService = require('./services/marketDataService');
const cryptoMonitor = require('./services/cryptoMonitor');
const slVerifier = require('./services/slVerifier');
const maintenanceService = require('./services/maintenanceService');
const paymentWatcher = require('./workers/paymentWatcher');
const securityMonitor = require('./services/securityMonitor');
const db = require('./models/database');

const app = express();

// Trust proxy for correct req.ip behind Passenger / reverse proxy
app.set('trust proxy', 1);

// CSP: strict in prod; disabled in dev/tests where inline bits + HMR fight it.
// Iconify / jsdelivr are CDN deps already used by /frontend.
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://code.iconify.design', 'https://api.iconify.design'],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  imgSrc: ["'self'", 'data:', 'https:'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
  connectSrc: ["'self'", 'https://api.iconify.design', 'wss:', 'https:'],
  frameAncestors: ["'none'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
};
app.use(helmet({
  contentSecurityPolicy: config.isProd ? { directives: cspDirectives } : false,
  frameguard: { action: 'deny' },
  hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));

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

// Request correlation ID — attaches req.id + req.log child logger,
// echoes X-Request-ID back to the client. Must run BEFORE any handler
// that might log, so trace context is always present.
const { requestIdMiddleware } = require('./middleware/requestId');
app.use(requestIdMiddleware);

// HTTP metrics — latency histogram + request counter, labelled by method
// and route pattern (not full path, to avoid cardinality explosions).
const metrics = require('./utils/metrics');
const httpLatency = metrics.histogram('chm_http_request_duration_ms',
  'HTTP request latency (ms)',
  { buckets: [5, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000], labelNames: ['method', 'route', 'status'] });
const httpRequests = metrics.counter('chm_http_requests_total',
  'Total HTTP requests', ['method', 'route', 'status']);
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const route = (req.route && req.route.path) ? req.baseUrl + req.route.path : req.path.split('?')[0];
    const labels = { method: req.method, route, status: String(res.statusCode) };
    httpLatency.observe(labels, Date.now() - start);
    httpRequests.inc(labels);
  });
  next();
});

// Request logging (skip static/health)
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/') && req.path !== '/api/health') {
    (req.log || logger).debug('→ ' + req.method + ' ' + req.path);
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
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/copy', copyRoutes);
app.use('/api/strategies', strategyMarketRoutes);
app.use('/api/risk', riskRoutes);
app.use('/api/ai', aiRoutes);

// Build info — resolved once at boot. Git SHA + build time come from
// BUILD_SHA / BUILD_TIME env vars (set by CI). Fall back to package.json
// version if not set.
const BUILD_INFO = Object.freeze({
  version: require('./package.json').version || '3.0.0',
  gitSha: process.env.BUILD_SHA || process.env.GIT_SHA || 'dev',
  buildTime: process.env.BUILD_TIME || null,
  node: process.version,
  startedAt: new Date().toISOString(),
});

app.get('/api/health', (_req, res) => {
  // Lightweight liveness probe.
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: BUILD_INFO.version });
});

// Version / build info — machine-parseable. Useful for canary detection,
// Datadog deploy markers, monitoring dashboards.
app.get('/api/version', (_req, res) => {
  res.json(BUILD_INFO);
});

// Gauges refreshed from DB on each /metrics scrape. Scanner runs in a
// worker thread (separate V8 isolate), so we can't share counters
// directly — we read from the DB instead, which is the source of truth.
const gActiveBots    = metrics.gauge('chm_active_bots', 'Currently active bots');
const gOpenTrades    = metrics.gauge('chm_open_trades', 'Open (unclosed) trades');
const gSignals24h    = metrics.gauge('chm_signals_last_24h', 'Signals produced in the last 24h');
const gTrades24h     = metrics.gauge('chm_trades_closed_last_24h', 'Trades closed in the last 24h');
const gUsers         = metrics.gauge('chm_users_total', 'Total registered users');
const gPaidUsers     = metrics.gauge('chm_users_paid', 'Users on a paid plan');
const gScannerAlive  = metrics.gauge('chm_scanner_alive', 'Scanner worker alive (1/0)');
function refreshGauges() {
  try {
    gActiveBots.set(db.prepare("SELECT COUNT(*) n FROM trading_bots WHERE is_active=1").get().n);
    gOpenTrades.set(db.prepare("SELECT COUNT(*) n FROM trades WHERE status='open'").get().n);
    gSignals24h.set(db.prepare("SELECT COUNT(*) n FROM signals WHERE created_at >= datetime('now','-1 day')").get().n);
    gTrades24h.set(db.prepare("SELECT COUNT(*) n FROM trades WHERE closed_at >= datetime('now','-1 day')").get().n);
    gUsers.set(db.prepare("SELECT COUNT(*) n FROM users").get().n);
    gPaidUsers.set(db.prepare("SELECT COUNT(*) n FROM subscriptions WHERE plan != 'free' AND status='active'").get().n);
    gScannerAlive.set(scannerWorker ? 1 : 0);
  } catch (_e) { /* metrics best-effort */ }
}

// Prometheus-format metrics endpoint. No auth by default; gate with
// METRICS_TOKEN env var or put behind a private network ACL in prod.
app.get('/metrics', (req, res) => {
  const tok = process.env.METRICS_TOKEN;
  if (tok && req.header('Authorization') !== 'Bearer ' + tok) {
    return res.status(401).type('text/plain').send('unauthorized');
  }
  refreshGauges();
  res.type('text/plain; version=0.0.4').send(metrics.render());
});

// Deeper readiness probe — verifies DB + background workers, reports subsystem status.
// Some cron-style monitors poll this every 10-30 seconds, so we cache the
// expensive bits (COUNT(*) FROM users full table scan, outbox/queue group-bys)
// for HEALTH_CACHE_MS so the probe stays cheap. Cache is per-process and
// cleared on restart, which is fine.
const HEALTH_CACHE_MS = 30_000;
let _healthCache = null;
app.get('/api/health/deep', (_req, res) => {
  if (_healthCache && Date.now() - _healthCache.at < HEALTH_CACHE_MS) {
    return res.status(_healthCache.statusCode).json(_healthCache.body);
  }
  const out = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: BUILD_INFO.version,
    gitSha: BUILD_INFO.gitSha,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    subsystems: {},
  };
  // DB probe — measures latency as a signal for lock contention
  const t0 = Date.now();
  try {
    const n = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
    out.subsystems.database = { ok: true, userCount: n, latencyMs: Date.now() - t0 };
  } catch (e) {
    out.status = 'degraded'; out.subsystems.database = { ok: false, error: e.message };
  }
  out.subsystems.scanner = { ok: scannerWorker !== null || IS_TEST };
  out.subsystems.partialTp = { ok: partialTpWorker !== null || partialTpTimer !== null || IS_TEST };
  out.subsystems.slVerifier = { ok: true };
  // Migration version — proves all schema changes applied at boot.
  try {
    const migrations = require('./models/migrations');
    out.subsystems.migrations = { ok: true, version: migrations.currentVersion(db) };
  } catch (e) {
    out.status = 'degraded';
    out.subsystems.migrations = { ok: false, error: e.message };
  }
  // Backtest queue depth — pending/running from the DB (fresh data, not
  // in-memory since restarts re-enqueue from the same DB state).
  try {
    const bq = db.prepare(
      `SELECT status, COUNT(*) AS n FROM backtests WHERE status IN ('pending','running','failed') GROUP BY status`,
    ).all();
    const by = { pending: 0, running: 0, failed24h: 0 };
    for (const r of bq) { if (r.status !== 'failed') by[r.status] = r.n; }
    by.failed24h = db.prepare(
      `SELECT COUNT(*) AS n FROM backtests WHERE status='failed' AND created_at >= datetime('now','-1 day')`,
    ).get().n;
    // Warn if >50 queued — suggests a stuck worker or runaway client.
    out.subsystems.backtestQueue = { ok: by.pending < 50, ...by };
    if (by.pending >= 50) out.status = out.status === 'ok' ? 'degraded' : out.status;
  } catch (e) {
    out.subsystems.backtestQueue = { ok: false, error: e.message };
  }
  // Email outbox health — warns if old pending rows suggest SMTP is down.
  try {
    const ob = db.prepare(
      `SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status`,
    ).all();
    const box = { pending: 0, sent: 0, failed: 0 };
    for (const r of ob) box[r.status] = r.n;
    // Oldest unsent — if this is hours old, something's wrong
    const oldest = db.prepare(
      `SELECT MIN(created_at) AS t FROM email_outbox WHERE status = 'pending'`,
    ).get().t;
    const stuckMinutes = oldest ? Math.round((Date.now() - new Date(oldest + 'Z').getTime()) / 60000) : 0;
    out.subsystems.emailOutbox = {
      ok: box.pending < 100 && stuckMinutes < 60,
      ...box, oldestPendingMinutes: stuckMinutes,
    };
    if (box.pending >= 100 || stuckMinutes >= 60) out.status = out.status === 'ok' ? 'degraded' : out.status;
  } catch (e) {
    // Outbox table may not exist on pre-v7 DBs — not fatal, just report.
    out.subsystems.emailOutbox = { ok: false, error: e.message };
  }
  // SMTP configuration — surfaces whether durable emails can actually leave
  // the outbox. A "true" here requires both SMTP_HOST and SMTP_USER.
  out.subsystems.smtp = {
    ok: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER),
    configured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER),
    host: process.env.SMTP_HOST ? process.env.SMTP_HOST.replace(/^.+@/, '…@') : null,
  };
  // Memory health — warn if RSS > 500MB
  if (out.memoryMb > 500) {
    out.status = out.status === 'ok' ? 'degraded' : out.status;
    out.subsystems.memory = { ok: false, rssMb: out.memoryMb, threshold: 500 };
  } else {
    out.subsystems.memory = { ok: true, rssMb: out.memoryMb };
  }
  const statusCode = out.status === 'ok' ? 200 : 503;
  _healthCache = { at: Date.now(), statusCode, body: out };
  res.status(statusCode).json(out);
});

// ── Static files (Passenger serves everything) ────────────────────────
const publicPath = path.join(require('os').homedir(), 'public_html');
app.use(express.static(publicPath, {
  // Long-cache .css / .js / fonts / images; short-cache HTML so the SPA
  // shell can update without ctrl+F5. Static assets are ~instant on
  // repeat visits (30d cache), HTML re-fetches every 5 minutes.
  setHeaders(res, filePath) {
    if (/\.(css|js|woff2?|ttf|eot|png|jpe?g|webp|svg|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    } else if (/\.html?$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    }
  },
}));

// SPA fallback — non-API routes serve index.html (also gets short cache)
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
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
  sentry.captureException(err, { path: req.path, method: req.method, userId: req.userId });
  res.status(500).json({
    error: config.isProd ? 'Internal server error' : (err && err.message) || 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
});

// ── Start: Passenger or standalone ────────────────────────────────────
const PORT = config.port || 3000;
const IS_TEST = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

// Capture unhandled rejections / uncaught exceptions in Sentry (no-op if disabled).
if (!IS_TEST) {
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { reason: reason && reason.message });
    sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { err: err.message, stack: err.stack });
    sentry.captureException(err);
  });
}

// ── Scanner worker_thread (Phase 6) ──────────────────────────────────
// Restart budget: if the worker crashes more than MAX_RESTARTS times in
// RESTART_WINDOW_MS, we stop auto-restarting and alert. Otherwise a broken
// strategy could thrash the CPU in a restart loop indefinitely.
let scannerWorker = null;
const RESTART_WINDOW_MS = 5 * 60_000;
const MAX_RESTARTS = 5;
const restartTimestamps = [];
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
      if (code === 0 || scannerShutdownRequested) return;

      const now = Date.now();
      while (restartTimestamps.length && restartTimestamps[0] < now - RESTART_WINDOW_MS) {
        restartTimestamps.shift();
      }
      if (restartTimestamps.length >= MAX_RESTARTS) {
        logger.error('scanner worker crashed too many times — auto-restart disabled', {
          restarts: restartTimestamps.length, windowMs: RESTART_WINDOW_MS,
        });
        try { sentry.captureException(new Error('scanner worker restart budget exhausted')); } catch (_e) {}
        return;
      }
      // Exponential-ish backoff: 5s, 10s, 20s, 40s, 80s
      const delay = 5_000 * Math.pow(2, restartTimestamps.length);
      restartTimestamps.push(now);
      setTimeout(() => { if (!scannerShutdownRequested) startScannerWorker(); }, delay);
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
    // Clear all timers so the event loop drains and process can exit cleanly.
    // Without these, graceful shutdown hangs until process.exit() force-kills.
    if (partialTpTimer) { clearInterval(partialTpTimer); partialTpTimer = null; }
    try { await stopPartialTpWorker(); } catch (_e) { /* */ }
    try { websocketService.shutdown(); } catch (e) { /* */ }
    try { db.close(); } catch (e) { /* */ }
    process.exit(0);
  };
}

// partialTpManager runs in its own worker_thread so its tickOpen
// loop (DB writes + candle fetches per open trade) doesn't pin the
// main event loop on accounts with many concurrent positions. The
// worker forwards trade_closed events back here for WebSocket
// broadcast — the parent process owns the WS clients.
let partialTpWorker = null;
let partialTpTimer = null; // legacy cron handle, kept null when worker mode is active
function startPartialTpWorker() {
  if (IS_TEST || process.env.PARTIAL_TP_DISABLED === '1') return;
  if (partialTpWorker) return;
  try {
    partialTpWorker = new Worker(path.join(__dirname, 'workers', 'partialTpWorker.js'), {
      env: process.env,
    });
    partialTpWorker.on('message', (msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'trade_closed' && msg.userId) {
        try {
          websocketService.broadcastToUser(msg.userId, {
            type: msg.type, data: msg.data, ts: msg.ts,
          });
        } catch (_e) { /* */ }
      } else if (msg.type === 'tick' && msg.closed > 0) {
        logger.debug('partialTp tick', { closed: msg.closed, processed: msg.processed });
      }
    });
    partialTpWorker.on('error', (err) => logger.error('partialTp worker error', { err: err.message }));
    partialTpWorker.on('exit', (code) => {
      logger.warn('partialTp worker exited', { code });
      partialTpWorker = null;
    });
    logger.info('partialTp worker started');
  } catch (err) {
    logger.error('failed to start partialTp worker', { err: err.message });
  }
}

async function stopPartialTpWorker() {
  if (!partialTpWorker) return;
  try { partialTpWorker.postMessage({ type: 'stop' }); } catch (_e) { /* */ }
  await new Promise((r) => setTimeout(r, 1500));
  try { partialTpWorker.terminate(); } catch (_e) { /* */ }
  partialTpWorker = null;
}

if (IS_TEST) {
  // Test env — do not start HTTP listener, just export the app for supertest
} else if (typeof(PhusionPassenger) !== 'undefined') {
  app.listen('passenger', () => logger.info('CHM Finance running via Passenger'));
  startScannerWorker();
  startPartialTpWorker();
  cryptoMonitor.start();
  slVerifier.start();
  maintenanceService.start();
  securityMonitor.start();
  paymentWatcher.start();
  process.on('SIGTERM', shutdown('SIGTERM'));
} else {
  const server = http.createServer(app);
  websocketService.init({ server });
  server.listen(PORT, () => logger.info('CHM Finance running on port ' + PORT));
  startScannerWorker();
  startPartialTpWorker();
  cryptoMonitor.start();
  slVerifier.start();
  maintenanceService.start();
  securityMonitor.start();
  paymentWatcher.start();

  process.on('SIGTERM', () => { shutdown('SIGTERM')().then(() => server.close()); });
  process.on('SIGINT',  () => { shutdown('SIGINT')().then(() => server.close()); });
}

module.exports = app;
