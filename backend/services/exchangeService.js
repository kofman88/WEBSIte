/**
 * Exchange keys service — per-user API keys, encrypted at rest.
 *
 * M0 (port plan §5): the CCXT client pool and every CCXT trading / balance /
 * market-data path were removed together with the `ccxt` dependency. The
 * bot's own exchange adapters (Bybit, BingX, Binance, OKX — REST + HMAC)
 * land in M13 under services/exchanges/*; until then `verifyKey` and
 * `getBalance` answer 501 NOT_IMPLEMENTED and new keys are stored unverified.
 *
 * Security:
 *  - api_key, api_secret, passphrase all encrypted at rest (AES-256-GCM)
 *  - plaintext never returned by any API; only `mask()`ed preview
 */

const db = require('../models/database');
const config = require('../config');
const plans = require('../config/plans');
const { encrypt, decrypt, mask } = require('../utils/crypto');

// The four exchanges the bot trades on (autotrade.md §14).
const SUPPORTED = ['bybit', 'binance', 'bingx', 'okx'];

// ── Helpers ──────────────────────────────────────────────────────────────
function encField(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  return encrypt(String(plaintext), config.walletEncryptionKey);
}

function decField(encrypted) {
  if (!encrypted) return null;
  return decrypt(encrypted, config.walletEncryptionKey);
}

function ensureSupported(exchange) {
  if (!SUPPORTED.includes(exchange)) {
    const err = new Error(`Exchange "${exchange}" is not supported`);
    err.statusCode = 400;
    err.code = 'UNSUPPORTED_EXCHANGE';
    throw err;
  }
}

function notImplemented(what) {
  const err = new Error(what + ' is not available until the exchange adapters land (port plan M13)');
  err.statusCode = 501;
  err.code = 'NOT_IMPLEMENTED';
  throw err;
}

function toPublic(r) {
  let apiKeyMasked = '••••';
  try { apiKeyMasked = mask(decField(r.api_key_encrypted)); } catch (_e) { /* decryption failed — show as opaque */ }
  return {
    id: r.id,
    exchange: r.exchange,
    apiKeyMasked,
    hasPassphrase: Boolean(r.passphrase_encrypted),
    isTestnet: Boolean(r.is_testnet),
    label: r.label,
    lastVerifiedAt: r.last_verified_at,
    lastError: r.last_error,
    createdAt: r.created_at,
  };
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Add a new exchange key for the user. Stored unverified (last_verified_at
 * NULL) until the M13 adapters can call the exchange.
 */
async function addKey(userId, { exchange, apiKey, apiSecret, passphrase, testnet = false, label = null }) {
  ensureSupported(exchange);

  // ── Plan gate: multi-exchange is Pro ─────────────────────────────────
  // Free is allowed exactly one exchange key total.
  const planRow = db.prepare('SELECT plan FROM subscriptions WHERE user_id = ?').get(userId);
  const plan = (planRow && planRow.plan) || 'free';
  if (!plans.canUseFeature(plan, 'multiExchange')) {
    const existingCount = db.prepare(
      'SELECT COUNT(*) AS n FROM exchange_keys WHERE user_id = ?'
    ).get(userId).n;
    if (existingCount >= 1) {
      const err = new Error('Multiple exchange keys require Pro plan or higher.');
      err.statusCode = 403; err.code = 'UPGRADE_REQUIRED';
      err.requiredPlan = plans.requiredPlanFor('multiExchange') || 'pro';
      throw err;
    }
  }

  const existing = db.prepare(
    'SELECT id FROM exchange_keys WHERE user_id = ? AND exchange = ? AND label IS ?'
  ).get(userId, exchange, label);
  if (existing) {
    const err = new Error('Key for this exchange+label already exists');
    err.statusCode = 409;
    err.code = 'DUPLICATE_KEY';
    throw err;
  }

  const result = db.prepare(`
    INSERT INTO exchange_keys
      (user_id, exchange, api_key_encrypted, api_secret_encrypted, passphrase_encrypted,
       is_testnet, label, last_verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    userId,
    exchange,
    encField(apiKey),
    encField(apiSecret),
    encField(passphrase),
    testnet ? 1 : 0,
    label
  );

  return getPublicKey(result.lastInsertRowid, userId);
}

/** Re-verify an existing key against the exchange — 501 until M13. */
async function verifyKey(keyId, userId) {
  const row = db.prepare(
    'SELECT id FROM exchange_keys WHERE id = ? AND user_id = ?'
  ).get(keyId, userId);
  if (!row) { const err = new Error('Key not found'); err.statusCode = 404; throw err; }
  return notImplemented('Key verification');
}

/**
 * List the user's keys — PLAINTEXT NEVER RETURNED. Only api-key last-4 masked.
 */
function listKeys(userId) {
  const rows = db.prepare(`
    SELECT id, exchange, api_key_encrypted, passphrase_encrypted, is_testnet,
           label, last_verified_at, last_error, created_at
    FROM exchange_keys
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);
  return rows.map(toPublic);
}

function getPublicKey(keyId, userId) {
  const r = db.prepare(`
    SELECT id, exchange, api_key_encrypted, passphrase_encrypted, is_testnet,
           label, last_verified_at, last_error, created_at
    FROM exchange_keys
    WHERE id = ? AND user_id = ?
  `).get(keyId, userId);
  if (!r) return null;
  return toPublic(r);
}

function deleteKey(keyId, userId) {
  const info = db.prepare('DELETE FROM exchange_keys WHERE id = ? AND user_id = ?').run(keyId, userId);
  if (info.changes === 0) { const err = new Error('Key not found'); err.statusCode = 404; throw err; }
  return { deleted: true };
}

/**
 * Decrypted credentials for a key. Internal only — never expose to API.
 * The M13 traders consume this shape ({ exchange, apiKey, apiSecret,
 * passphrase, testnet }).
 */
function getCredentials(keyId, userId = null) {
  const sql = userId
    ? 'SELECT * FROM exchange_keys WHERE id = ? AND user_id = ?'
    : 'SELECT * FROM exchange_keys WHERE id = ?';
  const params = userId ? [keyId, userId] : [keyId];
  const row = db.prepare(sql).get(...params);
  if (!row) { const err = new Error('Key not found'); err.statusCode = 404; throw err; }

  // decField → AES-GCM decrypt. Throws on tampered ciphertext, bad
  // WALLET_ENCRYPTION_KEY rotation, or DB corruption. Surface as a typed
  // error instead of a cryptic "invalid ciphertext".
  let apiKey; let apiSecret; let passphrase;
  try {
    apiKey = decField(row.api_key_encrypted);
    apiSecret = decField(row.api_secret_encrypted);
    passphrase = decField(row.passphrase_encrypted);
  } catch (_err) {
    const e = new Error('Failed to decrypt exchange key — re-add the key in Settings');
    e.statusCode = 503; e.code = 'DECRYPT_FAILED';
    throw e;
  }
  if (!apiKey || !apiSecret) {
    const e = new Error('Exchange key is missing apiKey or apiSecret');
    e.statusCode = 503; e.code = 'INVALID_EXCHANGE_KEY';
    throw e;
  }
  return { exchange: row.exchange, apiKey, apiSecret, passphrase, testnet: Boolean(row.is_testnet) };
}

/** Balance for a user's exchange key — 501 until M13. */
async function getBalance(keyId, userId) {
  getCredentials(keyId, userId); // ownership + decryptability check
  return notImplemented('Balance lookup');
}

function listSupported() {
  return SUPPORTED.slice();
}

module.exports = {
  addKey,
  verifyKey,
  listKeys,
  getPublicKey,
  deleteKey,
  getCredentials,
  getBalance,
  listSupported,
  SUPPORTED,
};
