const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
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
const websocketService = require('./services/websocketService');
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

function shutdown(sig) {
  return () => {
    logger.info('received ' + sig + ', shutting down');
    try { websocketService.shutdown(); } catch (e) { /* ignore */ }
    try { db.close(); } catch (e) { /* ignore */ }
    process.exit(0);
  };
}

if (typeof(PhusionPassenger) !== 'undefined') {
  app.listen('passenger', () => logger.info('CHM Finance running via Passenger'));
  process.on('SIGTERM', shutdown('SIGTERM'));
} else {
  const server = http.createServer(app);
  websocketService.init({ server });
  server.listen(PORT, () => logger.info('CHM Finance running on port ' + PORT));

  process.on('SIGTERM', () => { shutdown('SIGTERM')(); server.close(); });
  process.on('SIGINT',  () => { shutdown('SIGINT')();  server.close(); });
}

module.exports = app;
