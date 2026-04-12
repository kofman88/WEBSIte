require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || 'default-secret-change-in-production',
  databasePath: process.env.DATABASE_PATH || './data/chmup.db',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Wallet encryption
  walletEncryptionKey: process.env.WALLET_ENCRYPTION_KEY || 'default-32-byte-key-change-prod!', // Must be exactly 32 bytes
  walletEncryptionIv: process.env.WALLET_ENCRYPTION_IV || 'default-16byte!', // Must be exactly 16 bytes

  // Subscription / payment
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',

  // WebSocket
  wsPort: parseInt(process.env.WS_PORT, 10) || 3001,

  // CORS
  corsOrigin: process.env.CORS_ORIGIN || '*',

  // reCAPTCHA
  recaptchaSecret: process.env.RECAPTCHA_SECRET || '6Ld2DbQsAAAAALi2ikd9V_cxNyEmhTbf-2evyt_H',

  // Signal defaults
  signalDefaults: {
    maxFreeSignalsPerDay: 3,
    minConfidence: 60,
  },

  // Exchange configs
  exchanges: {
    bybit: {
      apiKey: process.env.BYBIT_API_KEY || '',
      apiSecret: process.env.BYBIT_API_SECRET || '',
    },
    bingx: {
      apiKey: process.env.BINGX_API_KEY || '',
      apiSecret: process.env.BINGX_API_SECRET || '',
    },
    binance: {
      apiKey: process.env.BINANCE_API_KEY || '',
      apiSecret: process.env.BINANCE_API_SECRET || '',
    },
  },
};
