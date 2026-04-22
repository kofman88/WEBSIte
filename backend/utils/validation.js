/**
 * Shared zod schemas used across routes for input validation.
 * Import and use: `.parse(req.body)` throws ZodError on invalid input,
 * which the global error handler converts to 400 with a readable message.
 */

const { z } = require('zod');

const EXCHANGES = ['bybit', 'binance', 'bingx', 'okx', 'bitget', 'htx', 'gate', 'bitmex'];
const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w'];
const STRATEGIES = ['levels', 'smc', 'gerchik', 'scalping', 'dca', 'grid'];
const SIDES = ['long', 'short'];
const DIRECTIONS = ['long', 'short', 'both'];
const PLANS = ['free', 'starter', 'pro', 'elite'];

const email = z.string().trim().toLowerCase().email().max(254);

const password = z.string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password too long')
  .refine((s) => /[a-zA-Z]/.test(s), 'Password must contain a letter')
  .refine((s) => /\d/.test(s), 'Password must contain a digit');

const displayName = z.string().trim().min(1).max(64).optional();

const referralCode = z.string().trim().regex(/^[A-Z0-9]{4,12}$/i).optional();

// Symbol: BTC/USDT, BTCUSDT, ETHUSDT-PERP, etc.
const symbol = z.string().trim().toUpperCase()
  .regex(/^[A-Z0-9]{2,12}([/-][A-Z0-9]{2,12})?(-PERP|-SWAP)?$/, 'Invalid symbol format');

const exchange = z.enum(EXCHANGES);
const timeframe = z.enum(TIMEFRAMES);
const strategy = z.enum(STRATEGIES);
const side = z.enum(SIDES);
const direction = z.enum(DIRECTIONS);
const plan = z.enum(PLANS);

const positiveNumber = z.number().positive();
const nonNegativeNumber = z.number().nonnegative();
const priceNumber = z.number().positive().finite();
const pctNumber = z.number().min(0).max(100);

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

// ── Auth ────────────────────────────────────────────────────────────────
// Given / family name as two optional fields (e.g. from the split
// register form). Backend composes display_name from them if displayName
// itself was not provided.
const personName = z.string().trim().min(1).max(64).optional();

const registerSchema = z.object({
  email,
  password,
  displayName,
  givenName: personName,
  familyName: personName,
  referralCode,
});

const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128), // looser on login (legacy accounts)
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

// ── Exchange keys ───────────────────────────────────────────────────────
const addKeySchema = z.object({
  exchange,
  apiKey: z.string().trim().min(4).max(256),
  apiSecret: z.string().trim().min(4).max(256),
  passphrase: z.string().trim().min(1).max(256).optional(),
  testnet: z.boolean().optional().default(false),
  label: z.string().trim().min(1).max(32).optional(),
});

// ── Bots ────────────────────────────────────────────────────────────────
const botBaseShape = z.object({
  name: z.string().trim().min(1).max(64),
  exchange,
  // Exchange key only required for live trading — paper bots don't need it.
  exchangeKeyId: z.number().int().positive().optional(),
  symbols: z.array(symbol).min(1).max(50),
  strategy,
  timeframe,
  direction: direction.default('both'),
  leverage: z.number().int().min(1).max(100).default(1),
  riskPct: z.number().min(0.1).max(10).default(1),
  maxOpenTrades: z.number().int().min(1).max(20).default(3),
  autoTrade: z.boolean().default(false),
  tradingMode: z.enum(['paper', 'live']).default('paper'),
  strategyConfig: z.record(z.any()).optional(),
  riskConfig: z.record(z.any()).optional(),
});
const liveKeyRefine = (b) => b.tradingMode !== 'live' || (typeof b.exchangeKeyId === 'number' && b.exchangeKeyId > 0);
const liveKeyIssue = { message: 'exchangeKeyId is required for live mode', path: ['exchangeKeyId'] };
const createBotSchema = botBaseShape.refine(liveKeyRefine, liveKeyIssue);
const updateBotSchema = botBaseShape.partial().refine(liveKeyRefine, liveKeyIssue);

// ── Backtests ───────────────────────────────────────────────────────────
const createBacktestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  strategy,
  exchange,
  symbols: z.array(symbol).min(1).max(20),
  timeframe,
  startDate: dateString,
  endDate: dateString,
  initialCapital: z.number().positive().max(10_000_000),
  strategyConfig: z.record(z.any()).optional(),
  riskConfig: z.record(z.any()).optional(),
});

// ── Payments ────────────────────────────────────────────────────────────
const stripeCheckoutSchema = z.object({
  plan: plan.exclude(['free']),
  billingCycle: z.enum(['monthly', 'yearly']).default('monthly'),
});

const cryptoPaymentSchema = z.object({
  plan: plan.exclude(['free']),
  network: z.enum(['bep20', 'trc20']),
});

const promoRedeemSchema = z.object({
  code: z.string().trim().min(1).max(32),
});

// ── Signal prefs ────────────────────────────────────────────────────────
const signalPrefsSchema = z.object({
  enabledStrategies: z.array(strategy).optional(),
  watchedSymbols: z.array(symbol).optional(),
  blacklistedSymbols: z.array(symbol).optional(),
  minConfidence: z.number().int().min(0).max(100).optional(),
  minRr: z.number().min(0).max(10).optional(),
  timeframes: z.array(timeframe).optional(),
  directions: z.array(side).optional(),
  notificationsWeb: z.boolean().optional(),
  notificationsEmail: z.boolean().optional(),
  notificationsTelegram: z.boolean().optional(),
  telegramChatId: z.string().trim().max(64).nullable().optional(),
});

module.exports = {
  // enums
  EXCHANGES, TIMEFRAMES, STRATEGIES, SIDES, DIRECTIONS, PLANS,
  // primitives
  email, password, symbol, exchange, timeframe, strategy, side, direction, plan,
  positiveNumber, nonNegativeNumber, priceNumber, pctNumber, dateString,
  // schemas
  registerSchema, loginSchema, refreshSchema,
  addKeySchema,
  createBotSchema, updateBotSchema,
  createBacktestSchema,
  stripeCheckoutSchema, cryptoPaymentSchema, promoRedeemSchema,
  signalPrefsSchema,
};
