const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const config = require('./config');

const authRoutes = require('./routes/auth');
const botsRoutes = require('./routes/bots');
const backtestsRoutes = require('./routes/backtests');
const exchangesRoutes = require('./routes/exchanges');
const subscriptionsRoutes = require('./routes/subscriptions');
const signalsRoutes = require('./routes/signals');
const walletRoutes = require('./routes/wallet');
const paymentRoutes = require('./routes/payments');
const tradeRoutes = require('./routes/trades');
const webhookRoutes = require('./routes/webhook');
const marketRoutes = require('./routes/market');
const websocketService = require('./services/websocketService');

const app = express();

// Security — disable CSP for CDN scripts
app.use(helmet({ contentSecurityPolicy: false }));

// CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── API Routes ───────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/bots', botsRoutes);
app.use('/api/backtests', backtestsRoutes);
app.use('/api/exchanges', exchangesRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/api/signals', signalsRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/market', marketRoutes);

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
  });
});

// ── Static files (Passenger serves everything) ──────────────────────────
const publicPath = path.join(require('os').homedir(), 'public_html');
app.use(express.static(publicPath));

// SPA fallback — non-API routes serve index.html
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(publicPath, 'index.html'));
  } else {
    res.status(404).json({ error: 'Route not found' });
  }
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('Server error:', err.stack);
  res.status(500).json({ error: config.nodeEnv === 'development' ? err.message : 'Internal server error' });
});

// ── Start: Passenger or standalone ──────────────────────────────────────
const PORT = config.port || 3000;

// Start signal scanner
const { startScanner } = require('./services/scannerEngine');
setTimeout(() => startScanner(), 3000);

// Start TON payment watcher
const { startTonWatcher } = require('./services/tonWatcher');
setTimeout(() => startTonWatcher(), 5000); // delay to let DB initialize

if (typeof(PhusionPassenger) !== 'undefined') {
  app.listen('passenger', () => console.log('CHM Finance running via Passenger'));
} else {
  const server = http.createServer(app);
  websocketService.init({ server });
  server.listen(PORT, () => console.log(`CHM Finance running on port ${PORT}`));

  process.on('SIGTERM', () => { websocketService.shutdown(); server.close(() => process.exit(0)); });
  process.on('SIGINT', () => { websocketService.shutdown(); server.close(() => process.exit(0)); });
}

module.exports = app;
