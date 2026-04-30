/**
 * Exchange service — CCXT wrapper for managing per-user API keys + client pool.
 *
 * Security:
 *  - api_key, api_secret, passphrase all encrypted at rest (AES-256-GCM)
 *  - plaintext never returned by any API; only `mask()`ed preview
 *  - client pool (LRU) reuses expensive CCXT instances across requests
 */

const ccxt = require('ccxt');
const db = require('../models/database');
const config = require('../config');
const plans = require('../config/plans');
const { encrypt, decrypt, mask } = require('../utils/crypto');
const logger = require('../utils/logger');

const SUPPORTED = ['bybit', 'binance', 'bingx', 'okx', 'bitget', 'htx', 'gate', 'bitmex'];

// ── LRU cache: keyId → { client, loadedAt } ──────────────────────────────
const CLIENT_TTL_MS = 10 * 60 * 1000;
const CLIENT_MAX = 100;
const clientCache = new Map(); // insertion-ordered = naive LRU

function pruneCache() {
  const now = Date.now();
  for (const [k, v] of clientCache) {
    if (now - v.loadedAt > CLIENT_TTL_MS) clientCache.delete(k);
  }
  while (clientCache.size > CLIENT_MAX) {
    const oldest = clientCache.keys().next().value;
    clientCache.delete(oldest);
  }
}

function cacheGet(keyId) {
  const entry = clientCache.get(keyId);
  if (!entry) return null;
  if (Date.now() - entry.loadedAt > CLIENT_TTL_MS) {
    clientCache.delete(keyId);
    return null;
  }
  // Refresh position (naive LRU)
  clientCache.delete(keyId);
  clientCache.set(keyId, entry);
  return entry.client;
}

function cacheSet(keyId, client) {
  clientCache.set(keyId, { client, loadedAt: Date.now() });
  pruneCache();
}

function cacheDrop(keyId) {
  clientCache.delete(keyId);
}

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

function makeCcxt(exchange, { apiKey, apiSecret, passphrase, testnet }) {
  if (typeof ccxt[exchange] !== 'function') {
    throw new Error(`CCXT missing class for ${exchange}`);
  }
  const opts = {
    apiKey,
    secret: apiSecret,
    enableRateLimit: true,
    timeout: 15000,
  };
  if (passphrase) opts.password = passphrase;
  const client = new ccxt[exchange](opts);
  if (testnet && typeof client.setSandboxMode === 'function') {
    client.setSandboxMode(true);
  }
  return client;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Add a new exchange key for the user.
 * Verifies the key by calling fetchBalance; throws on failure so bad keys
 * never reach the DB.
 */
async function addKey(userId, { exchange, apiKey, apiSecret, passphrase, testnet = false, label = null }) {
  ensureSupported(exchange);

  // ── Plan gate: multi-exchange is Pro+ ────────────────────────────────
  // Free / Starter are allowed exactly one exchange key total. Inventory
  // pitches "4 exchanges" as a Pro perk, so we cap at the connection
  // count rather than the exchange-name list (a single Bybit key is fine
  // for Starter; a second key on any exchange — even same Bybit — is not).
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

  // Pre-flight verify before saving
  const client = makeCcxt(exchange, { apiKey, apiSecret, passphrase, testnet });
  try {
    await client.fetchBalance();
  } catch (e) {
    const err = new Error('Exchange key verification failed: ' + (e.message || e));
    err.statusCode = 400;
    err.code = 'KEY_VERIFY_FAILED';
    throw err;
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
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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

/**
 * Re-verify an existing key against the exchange. Updates last_verified_at
 * on success or last_error on failure.
 */
async function verifyKey(keyId, userId) {
  const row = db.prepare(
    'SELECT * FROM exchange_keys WHERE id = ? AND user_id = ?'
  ).get(keyId, userId);
  if (!row) { const err = new Error('Key not found'); err.statusCode = 404; throw err; }

  const apiKey = decField(row.api_key_encrypted);
  const apiSecret = decField(row.api_secret_encrypted);
  const passphrase = decField(row.passphrase_encrypted);
  const client = makeCcxt(row.exchange, {
    apiKey, apiSecret, passphrase, testnet: Boolean(row.is_testnet),
  });

  try {
    await client.fetchBalance();
    db.prepare(
      'UPDATE exchange_keys SET last_verified_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?'
    ).run(keyId);
    cacheDrop(keyId); // force rebuild so fresh creds used
    return { verified: true };
  } catch (e) {
    db.prepare(
      'UPDATE exchange_keys SET last_error = ? WHERE id = ?'
    ).run((e.message || String(e)).slice(0, 500), keyId);
    cacheDrop(keyId);
    const err = new Error('Verification failed: ' + (e.message || e));
    err.statusCode = 400;
    err.code = 'KEY_VERIFY_FAILED';
    throw err;
  }
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

  return rows.map((r) => {
    let apiKeyMasked = '••••';
    try {
      const plain = decField(r.api_key_encrypted);
      apiKeyMasked = mask(plain);
    } catch (_e) { /* decryption failed — show as opaque */ }
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
  });
}

function getPublicKey(keyId, userId) {
  const r = db.prepare(`
    SELECT id, exchange, api_key_encrypted, passphrase_encrypted, is_testnet,
           label, last_verified_at, last_error, created_at
    FROM exchange_keys
    WHERE id = ? AND user_id = ?
  `).get(keyId, userId);
  if (!r) return null;
  let apiKeyMasked = '••••';
  try { apiKeyMasked = mask(decField(r.api_key_encrypted)); } catch (_e) { /* */ }
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

function deleteKey(keyId, userId) {
  const info = db.prepare('DELETE FROM exchange_keys WHERE id = ? AND user_id = ?').run(keyId, userId);
  if (info.changes === 0) { const err = new Error('Key not found'); err.statusCode = 404; throw err; }
  cacheDrop(keyId);
  return { deleted: true };
}

/**
 * Get a CCXT client for the given key, with LRU cache.
 * Internal only — never expose to API.
 */
function getCcxtClient(keyId, userId = null) {
  const cached = cacheGet(keyId);
  if (cached) return cached;

  const sql = userId
    ? 'SELECT * FROM exchange_keys WHERE id = ? AND user_id = ?'
    : 'SELECT * FROM exchange_keys WHERE id = ?';
  const params = userId ? [keyId, userId] : [keyId];
  const row = db.prepare(sql).get(...params);
  if (!row) { const err = new Error('Key not found'); err.statusCode = 404; throw err; }

  // decField → AES-GCM decrypt. Throws on tampered ciphertext, bad
  // WALLET_ENCRYPTION_KEY rotation, or DB corruption. Surface as a
  // typed error instead of letting the trade-flow crash with a
  // cryptic "invalid ciphertext" — the bot pause flow upstream
  // checks .code so we set DECRYPT_FAILED.
  let apiKey; let apiSecret; let passphrase;
  try {
    apiKey = decField(row.api_key_encrypted);
    apiSecret = decField(row.api_secret_encrypted);
    passphrase = decField(row.passphrase_encrypted);
  } catch (err) {
    const e = new Error('Failed to decrypt exchange key — re-add the key in Settings');
    e.statusCode = 503; e.code = 'DECRYPT_FAILED';
    throw e;
  }
  // Reject keys saved with empty/null fields. CCXT would happily
  // create a client with apiKey=null, then the exchange answers 401
  // and we'd open a "live" trade with no actual order placed.
  if (!apiKey || !apiSecret) {
    const e = new Error('Exchange key is missing apiKey or apiSecret');
    e.statusCode = 503; e.code = 'INVALID_EXCHANGE_KEY';
    throw e;
  }

  const client = makeCcxt(row.exchange, {
    apiKey, apiSecret, passphrase,
    testnet: Boolean(row.is_testnet),
  });
  cacheSet(keyId, client);
  return client;
}

/**
 * Fetch balance for a user's exchange key.
 */
async function getBalance(keyId, userId) {
  const client = getCcxtClient(keyId, userId);
  const bal = await client.fetchBalance();
  // Return a trimmed shape — CCXT balance objects are enormous
  const out = { total: bal.total, free: bal.free, used: bal.used };
  return out;
}

function listSupported() {
  return SUPPORTED.slice();
}

// For tests
function _clearCache() { clientCache.clear(); }
function _getCacheSize() { return clientCache.size; }

module.exports = {
  addKey,
  verifyKey,
  listKeys,
  getPublicKey,
  deleteKey,
  getCcxtClient,
  getBalance,
  listSupported,
  SUPPORTED,
  _clearCache,
  _getCacheSize,
};
