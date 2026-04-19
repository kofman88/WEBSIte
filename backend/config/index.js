require('dotenv').config();

// ── Fail-fast validation of critical env vars ────────────────────────────
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const errors = [];

function requireEnv(name, { minLength = 0, exactHexLength = null, prodOnly = false } = {}) {
  const value = process.env[name];
  if (!value) {
    if (prodOnly && !IS_PROD) return null;
    errors.push(`Missing ENV: ${name}`);
    return null;
  }
  if (minLength && value.length < minLength) {
    errors.push(`ENV ${name} must be at least ${minLength} chars (got ${value.length})`);
  }
  if (exactHexLength && (!/^[0-9a-fA-F]+$/.test(value) || value.length !== exactHexLength)) {
    errors.push(`ENV ${name} must be exactly ${exactHexLength} hex chars (got ${value.length})`);
  }
  return value;
}

const jwtSecret = requireEnv('JWT_SECRET', { minLength: 32 });
const jwtRefreshSecret = requireEnv('JWT_REFRESH_SECRET', { minLength: 32 });
const walletEncryptionKey = requireEnv('WALLET_ENCRYPTION_KEY', { exactHexLength: 64 });

if (IS_PROD) {
  // Stripe is optional — endpoints return 503 when keys are missing.
  // Only CORS_ORIGIN is mandatory in prod (cross-site cookies / CSRF safety).
  requireEnv('CORS_ORIGIN', { prodOnly: true });
}

if (errors.length) {
  // eslint-disable-next-line no-console
  console.error('\n❌ Configuration errors:\n');
  errors.forEach((e) => console.error('  - ' + e));
  console.error('\nSee backend/.env.example for the full list of required variables.\n');
  if (IS_PROD) process.exit(1);
  // In dev we warn but continue — generates random weak secrets for local testing
  console.error('⚠️  Running in dev mode with weak defaults. DO NOT deploy like this.\n');
}

// ── Dev fallbacks (never used in prod because process.exit above) ────────
function devFallback(value, fallback) {
  if (IS_PROD) return value;
  return value || fallback;
}

module.exports = {
  nodeEnv: NODE_ENV,
  isProd: IS_PROD,
  port: parseInt(process.env.PORT, 10) || 3000,
  wsPort: parseInt(process.env.WS_PORT, 10) || 3001,

  // Critical secrets
  jwtSecret: devFallback(jwtSecret, 'dev-only-jwt-secret-32chars-long!!!!'),
  jwtRefreshSecret: devFallback(jwtRefreshSecret, 'dev-only-refresh-32chars-long!!!!!'),
  jwtAccessTtl: process.env.JWT_ACCESS_TTL || '1h',
  jwtRefreshTtl: process.env.JWT_REFRESH_TTL || '30d',
  walletEncryptionKey: devFallback(
    walletEncryptionKey,
    '0'.repeat(64) // 64 hex chars = 32 bytes, all zeros — dev only
  ),

  // Database
  databasePath: process.env.DATABASE_PATH || './data/chmup.db',

  // CORS — strict in prod, open in dev
  corsOrigin: IS_PROD
    ? (process.env.CORS_ORIGIN || 'https://chmup.top')
    : (process.env.CORS_ORIGIN || '*'),

  // Payments
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripePublicKey: process.env.STRIPE_PUBLIC_KEY || '',
  paymentBep20Address: process.env.PAYMENT_BEP20_ADDRESS || '',
  paymentTrc20Address: process.env.PAYMENT_TRC20_ADDRESS || '',
  bscscanApiKey: process.env.BSCSCAN_API_KEY || '',
  tronscanApiKey: process.env.TRONSCAN_API_KEY || '',

  // Monitoring
  sentryDsn: process.env.SENTRY_DSN || '',
  logLevel: process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug'),

  // Signal defaults
  signalDefaults: {
    maxFreeSignalsPerDay: 3,
    minConfidence: 60,
  },
};
