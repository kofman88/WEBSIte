/**
 * AES-256-GCM encryption for API keys and other secrets at rest.
 *
 * Format of ciphertext stored in DB:
 *   base64(iv) + ':' + base64(ciphertext) + ':' + base64(authTag)
 *
 * - iv (nonce) is 12 bytes, freshly generated for EACH encryption
 * - authTag is 16 bytes, produced by GCM mode
 * - key must be exactly 32 bytes (provided as 64 hex chars via ENV)
 *
 * NEVER log plaintext values. NEVER return plaintext in API responses —
 * only masked form like "...ab12" (last 4 chars).
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

function keyFromHex(hexKey) {
  if (typeof hexKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error('Encryption key must be 64 hex chars (32 bytes)');
  }
  return Buffer.from(hexKey, 'hex');
}

/**
 * Encrypt a UTF-8 string.
 * @param {string} plaintext
 * @param {string} hexKey 64-char hex string
 * @returns {string} "iv:ct:tag" (all base64)
 */
function encrypt(plaintext, hexKey) {
  if (typeof plaintext !== 'string') throw new Error('plaintext must be a string');
  const key = keyFromHex(hexKey);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}

/**
 * Decrypt a previously encrypted string. Throws on tampering/bad key.
 * @param {string} encoded "iv:ct:tag" format
 * @param {string} hexKey  64-char hex string
 * @returns {string} plaintext
 */
function decrypt(encoded, hexKey) {
  if (typeof encoded !== 'string' || !encoded.includes(':')) {
    throw new Error('invalid ciphertext format');
  }
  const parts = encoded.split(':');
  if (parts.length !== 3) throw new Error('invalid ciphertext format');
  const [ivB64, ctB64, tagB64] = parts;
  const key = keyFromHex(hexKey);
  const iv = Buffer.from(ivB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES) throw new Error('invalid iv length');
  if (tag.length !== 16) throw new Error('invalid tag length');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * Mask an API key for display in UI — keep last 4 visible.
 * @param {string} value
 * @returns {string} e.g. "••••1a2b"
 */
function mask(value) {
  if (!value || value.length < 4) return '••••';
  return '••••' + value.slice(-4);
}

/**
 * Generate a 32-byte random hex string suitable for WALLET_ENCRYPTION_KEY.
 * For setup scripts.
 */
function generateKey() {
  return crypto.randomBytes(KEY_BYTES).toString('hex');
}

/**
 * Hash a value with SHA-256 (for non-reversible lookups like refresh_tokens.token_hash).
 */
function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two strings (same length required).
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = { encrypt, decrypt, mask, generateKey, sha256, safeEqual };
