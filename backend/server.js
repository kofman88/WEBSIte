const http = require('http');
const path = require('path');
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
const exchangesRoutes = require('./routes/exchanges');
const subscriptionsRoutes = require('./routes/subscriptions');
const paymentsRoutes = require('./routes/payments');
const adminRoutes = require('./routes/admin');
const notificationsRoutes = require('./routes/notifications');
const telegramRoutes = require('./routes/telegram');
const publicRoutes = require('./routes/public');
const publicLandingRoutes = require('./routes/publicLanding');
const supportRoutes = require('./routes/support');
const pushRoutes = require('./routes/push');
const appRoutes = require('./routes/app');
const { readBotBody } = require('./services/engine/botBody');
const botTransport = require('./services/engine/botTransport');
const planService = require('./services/planService');
const maintenanceService = require('./services/maintenanceService');
const paymentWatcher = require('./workers/paymentWatcher');
const securityMonitor = require('./services/securityMonitor');
const db = require('./models/database');

const app = express();

// Trust proxy for correct req.ip behind Passenger / reverse proxy
app.set('trust proxy', 1);

// CSP: the whole production policy lives in config/csp.js (why each source is there); disabled in
// dev/tests where inline bits + HMR fight it.
const { helmetCsp } = require('./config/csp');
app.use(helmet({
  contentSecurityPolicy: helmetCsp(config.isProd),
  frameguard: { action: 'deny' },
  hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));

const corsMw = cors({
  origin: config.corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});
// /api/app/* is the bot's Mini App API served same-origin (frontend/app): no CORS there, like the
// bot's aiohttp app — an OPTIONS request reaches the router's "405: Method Not Allowed" + Allow.
app.use((req, res, next) => (req.path === '/api/app' || req.path.startsWith('/api/app/') ? next() : corsMw(req, res, next)));

app.use(compression());

// Global per-IP rate-limit across /api (skipped in tests). An authenticated /api/app request is
// not counted: that surface has the bot's own per-user buckets (routes/app.js — POST 30 / 60 s,
// chart, plan, challenge, share, feedback, analyze) and the bot has no per-IP cap on it; users
// behind one NAT / carrier IP must not share 300 requests per 15 min of the app's polling. Requests
// without a valid access token (scans, floods, expired tokens) still count per IP.
if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { error: 'Too many requests, please try again later', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => require('./middleware/auth').isAuthenticatedAppRequest(req),
  });
  app.use('/api/', globalLimiter);
}

// Stripe webhook needs RAW body for signature verification — mount raw
// parser ONLY for that specific path before the global JSON parser.
app.use('/api/payments/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }),
  (req, _res, next) => { req.rawBody = req.body; next(); });

// /api/app/* reads its body like the bot's miniapp_api._read_body() on aiohttp (botBody.js):
// Content-Type ignored, strict decode by its charset (utf-8 by default), json.loads; malformed
// JSON, a BOM, invalid bytes or a top level that is not an object reach the route as {}, so it
// answers with its own business error instead of a 400 from the strict parser. The transport in
// front of it is aiohttp's too (botTransport.js): the 1 MiB client_max_size, gzip / deflate
// request bodies; an oversized or undecodable body is {} for the route (never a 413 / 415 JSON),
// br / zstd and a cut deflate stream are aiohttp's transport 400.
app.use('/api/app', botTransport.middleware(), (req, _res, next) => {
  req.body = readBotBody(req.body, req.headers['content-type']);
  next();
});
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
// Port plan (docs/port/PLAN.md §2.7): the engine's user-facing API arrives
// as `/api/app/*` from M7 onward. Everything the bot does not have (bots,
// backtests, signals v1, wallet, analytics, copy-trading, marketplace,
// risk, AI, TradingView webhooks) was removed in M0.
app.use('/api/auth', authRoutes);
app.use('/api/exchanges', exchangesRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/public', publicRoutes);
// The landing's read-only data (M10b): trend / stats / feed of the paper track (services/publicTrack).
app.use('/api/public', publicLandingRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/push', pushRoutes);
// The bot's Mini App API (M7+): me, strategy, settings, settings/all, profile,
// lang, plan, help, settings/reset, volume/reset — Mini App envelope.
app.use('/api/app', appRoutes);

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

// Gauges refreshed from DB on each /metrics scrape. Engine gauges (signals,
// open trades, scanner liveness) return with the engine worker (M9/M10).
const gUsers         = metrics.gauge('chm_users_total', 'Total registered users');
const gPaidUsers     = metrics.gauge('chm_users_paid', 'Users on a paid plan');
function refreshGauges() {
  try {
    gUsers.set(db.prepare("SELECT COUNT(*) n FROM users").get().n);
    gPaidUsers.set(db.prepare("SELECT COUNT(*) n FROM subscriptions WHERE plan != 'free' AND status='active'").get().n);
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
  // Migration version — proves all schema changes applied at boot.
  try {
    const migrations = require('./models/migrations');
    out.subsystems.migrations = { ok: true, version: migrations.currentVersion(db) };
  } catch (e) {
    out.status = 'degraded';
    out.subsystems.migrations = { ok: false, error: e.message };
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

// Background services. The signal engine (workers/engineWorker.js: scanners, WS feeds, trend
// monitor, tracker … in a worker thread + ghost cleanup / Genome loops here) starts when
// config.engineWorker (ENGINE_WORKER=1, default on in production); never under tests.
let engine = null;
function startBackground() {
  maintenanceService.start();
  securityMonitor.start();
  paymentWatcher.start();
  // bot loop A: hourly subscription expiry / renewal reminders (first run after 60 s)
  planService.startExpiryLoop();
  // the public paper track's minute refresh (stage history of the landing feed, services/publicTrack)
  try { require('./services/publicTrack').defaultTrack().start(); } catch (err) { logger.error('public track start failed', { err: err.message }); }
  if (config.engineWorker && !IS_TEST) {
    try {
      engine = require('./workers/engineWorker').startEngine({ log: logger });
      logger.info('engine worker started');
    } catch (err) {
      logger.error('engine worker start failed', { err: err.message });
    }
  }
}

// Graceful stop (utils/gracefulShutdown.js = bot.py _request_stop): SIGTERM / SIGINT and, under
// Passenger, the PhusionPassenger 'exit' event (Passenger stops an app by closing its stdin and
// calls process.exit(0) at once unless the app listens for 'exit'); a second request exits at
// once, a 22 s deadline bounds the whole stop.
let httpServer = null;
async function shutdownSteps() {
  if (httpServer) {
    try { httpServer.close(); } catch (_e) { /* */ }
  }
  if (engine) {
    try { await engine.stop(); } catch (_e) { /* */ }
    engine = null;
  }
  try { maintenanceService.stop(); } catch (_e) { /* */ }
  try { planService.stopExpiryLoop(); } catch (_e) { /* */ }
  try { require('./services/publicTrack').defaultTrack().stop(); } catch (_e) { /* */ }
  try { db.close(); } catch (_e) { /* */ }
}

if (IS_TEST) {
  // Test env — do not start HTTP listener, just export the app for supertest
} else {
  const { createStopRequest, installStopHandlers } = require('./utils/gracefulShutdown');
  const stop = createStopRequest({ run: shutdownSteps, log: logger });
  if (typeof(PhusionPassenger) !== 'undefined') {
    app.listen('passenger', () => logger.info('CHM Finance running via Passenger'));
    startBackground();
    // eslint-disable-next-line no-undef
    installStopHandlers(stop, { passenger: PhusionPassenger });
  } else {
    httpServer = http.createServer(app);
    httpServer.listen(PORT, () => logger.info('CHM Finance running on port ' + PORT));
    startBackground();
    installStopHandlers(stop);
  }
}

module.exports = app;
