const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const config = require('./config');

// Route imports
const authRoutes = require('./routes/auth');
const botsRoutes = require('./routes/bots');
const backtestsRoutes = require('./routes/backtests');
const exchangesRoutes = require('./routes/exchanges');
const subscriptionsRoutes = require('./routes/subscriptions');
const signalsRoutes = require('./routes/signals');
const walletRoutes = require('./routes/wallet');

// WebSocket
const websocketService = require('./services/websocketService');

const app = express();

// Security
app.use(helmet());

// CORS
app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Compression
app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging (dev only)
if (config.nodeEnv === 'development') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });
}

// ── API Routes ───────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/bots', botsRoutes);
app.use('/api/backtests', backtestsRoutes);
app.use('/api/exchanges', exchangesRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/api/signals', signalsRoutes);
app.use('/api/wallet', walletRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  const wsStats = websocketService.getStats();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    websocket: wsStats,
  });
});

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('Server error:', err.stack);

  if (config.nodeEnv === 'development') {
    res.status(500).json({
      error: err.message,
      stack: err.stack,
    });
  } else {
    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

// ── Start ────────────────────────────────────────────────────────────────
const PORT = config.port;
const server = http.createServer(app);

// Attach WebSocket to the same HTTP server
websocketService.init({ server });

server.listen(PORT, () => {
  console.log(`
====================================================
  CHM Finance Backend v2.0.0
  Port:        ${PORT}
  Mode:        ${config.nodeEnv}
  WebSocket:   ws://localhost:${PORT}/ws

  API Endpoints:
  POST /api/auth/register       Register
  POST /api/auth/login          Login
  GET  /api/auth/me             Current user

  GET  /api/bots                List bots
  POST /api/bots                Create bot
  GET  /api/bots/stats          Bot stats

  GET  /api/backtests           List backtests
  POST /api/backtests           Create backtest

  GET  /api/exchanges/exchanges       Supported exchanges
  GET  /api/exchanges/balance/:name   Exchange balance

  GET  /api/subscriptions/plans       Plan catalogue
  GET  /api/subscriptions/status      User subscription
  POST /api/subscriptions/activate    Activate plan
  POST /api/subscriptions/promo       Apply promo code

  GET  /api/signals             Signals (paginated)
  GET  /api/signals/live        SSE real-time feed
  GET  /api/signals/stats       Signal performance
  POST /api/signals/settings    Signal preferences

  POST /api/wallet/create       Create wallet
  GET  /api/wallet/balance      Wallet balance
  POST /api/wallet/withdraw     Request withdrawal
  GET  /api/wallet/transactions Transaction history

  GET  /api/health              Health check
====================================================
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  websocketService.shutdown();
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  websocketService.shutdown();
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

module.exports = app;
