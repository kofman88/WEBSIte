/**
 * Shared zod schemas used across routes for input validation.
 * Import and use: `.parse(req.body)` throws ZodError on invalid input,
 * which the global error handler converts to 400 with a readable message.
 */

const { z } = require('zod');

// Enums mirror the bot (port plan §0 conventions): 4 exchanges, the
// user-facing timeframes, the three strategies.
const EXCHANGES = ['bybit', 'binance', 'bingx', 'okx'];
const TIMEFRAMES = ['15m', '30m', '1h', '4h', '1d'];
const STRATEGIES = ['levels', 'smc', 'volume'];
const SIDES = ['long', 'short'];
const DIRECTIONS = ['long', 'short', 'both'];
// Two tiers like the bot. Retired ids (starter / elite / beginner) are not
// accepted on input any more; stored rows go through config/plans.normalizePlan.
const PLANS = ['free', 'pro'];

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

// ── Payments ────────────────────────────────────────────────────────────
// monthly = 30 days at the plan price, yearly = 365 days at 12 × price − 20%
// (services/paymentService.js planPrice / BILLING_DAYS). Both checkouts carry it to the invoice.
const billingCycle = z.enum(['monthly', 'yearly']).default('monthly');

const stripeCheckoutSchema = z.object({
  plan: plan.exclude(['free']),
  billingCycle,
});

// billingCycle used to be missing here: zod strips unknown keys, so the settings checkout's
// «Год −20%» reached paymentService as monthly (a 30-day invoice at the monthly price).
const cryptoPaymentSchema = z.object({
  plan: plan.exclude(['free']),
  network: z.enum(['bep20', 'trc20']),
  billingCycle,
});

const promoRedeemSchema = z.object({
  code: z.string().trim().min(1).max(32),
});

module.exports = {
  // enums
  EXCHANGES, TIMEFRAMES, STRATEGIES, SIDES, DIRECTIONS, PLANS,
  // primitives
  email, password, symbol, exchange, timeframe, strategy, side, direction, plan, billingCycle,
  positiveNumber, nonNegativeNumber, priceNumber, pctNumber, dateString,
  // schemas
  registerSchema, loginSchema, refreshSchema,
  addKeySchema,
  stripeCheckoutSchema, cryptoPaymentSchema, promoRedeemSchema,
};
