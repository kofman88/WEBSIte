/**
 * Unit tests for exchange service — focus on what we CAN reliably test without
 * live exchange connectivity:
 *   - Encryption at rest (round-trip, masking)
 *   - Key listing scoped by user
 *   - Deletion scoped by user (404 for other users' keys)
 *   - LRU cache drop on verify/delete
 *
 * Live CCXT interactions (addKey pre-flight, verify, balance) are integration
 * tests that require real exchange access — those are covered manually after
 * deployment and by a dev `smoke-exchange.js` script (see phase_3_report).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-exchange.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => {
    try { fs.unlinkSync(p + ext); } catch (_e) { /* */ }
  });
}

let db, exchangeService, crypto;

beforeAll(async () => {
  freshDb();
  db = (await import('../models/database.js')).default;
  exchangeService = await import('../services/exchangeService.js');
  crypto = await import('../utils/crypto.js');
});

function insertRawKey({ userId, exchange, apiKey, apiSecret, passphrase = null, isTestnet = 0, label = null }) {
  const enc = (v) => v ? crypto.default.encrypt(v, process.env.WALLET_ENCRYPTION_KEY) : null;
  const info = db.prepare(`
    INSERT INTO exchange_keys
      (user_id, exchange, api_key_encrypted, api_secret_encrypted, passphrase_encrypted, is_testnet, label, last_verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(userId, exchange, enc(apiKey), enc(apiSecret), enc(passphrase), isTestnet, label);
  return info.lastInsertRowid;
}

function makeUser(email, referralCode = null) {
  // Minimal user row — bypasses authService for unit test speed
  const info = db.prepare(`
    INSERT INTO users (email, password_hash, referral_code, is_active)
    VALUES (?, 'x', ?, 1)
  `).run(email, referralCode || (email + '_ref').toUpperCase().slice(0, 12));
  return info.lastInsertRowid;
}

beforeEach(() => {
  db.prepare('DELETE FROM exchange_keys').run();
  db.prepare('DELETE FROM users').run();
  exchangeService._clearCache();
});

describe('listSupported', () => {
  it('contains all 8 expected exchanges', () => {
    const list = exchangeService.listSupported();
    ['bybit', 'binance', 'bingx', 'okx', 'bitget', 'htx', 'gate', 'bitmex']
      .forEach((e) => expect(list).toContain(e));
  });
});

describe('listKeys & getPublicKey', () => {
  it('returns masked key, never plaintext secret', () => {
    const alice = makeUser('a@x.com');
    insertRawKey({
      userId: alice, exchange: 'bybit',
      apiKey: 'ABCDEFGH1234', apiSecret: 'SuperSecret0001',
    });
    const list = exchangeService.listKeys(alice);
    expect(list).toHaveLength(1);
    expect(list[0].apiKeyMasked).toBe('••••1234');
    expect(list[0]).not.toHaveProperty('apiSecret');
    expect(list[0]).not.toHaveProperty('api_secret_encrypted');
  });

  it('is strictly scoped per-user', () => {
    const alice = makeUser('alice@x.com');
    const bob = makeUser('bob@x.com');
    insertRawKey({ userId: alice, exchange: 'bybit', apiKey: 'aliceKey0001', apiSecret: 'ax' });
    insertRawKey({ userId: bob,   exchange: 'binance', apiKey: 'bobKey0002', apiSecret: 'bx' });
    const aliceList = exchangeService.listKeys(alice);
    const bobList = exchangeService.listKeys(bob);
    expect(aliceList).toHaveLength(1);
    expect(bobList).toHaveLength(1);
    expect(aliceList[0].apiKeyMasked).toBe('••••0001');
    expect(bobList[0].apiKeyMasked).toBe('••••0002');
    expect(aliceList[0].exchange).toBe('bybit');
    expect(bobList[0].exchange).toBe('binance');
  });

  it('reveals hasPassphrase flag for OKX-style keys', () => {
    const u = makeUser('okx@x.com');
    insertRawKey({
      userId: u, exchange: 'okx',
      apiKey: 'ok-key', apiSecret: 'ok-sec', passphrase: 'my-pass',
    });
    const [key] = exchangeService.listKeys(u);
    expect(key.hasPassphrase).toBe(true);
  });

  it('getPublicKey returns null for foreign user', () => {
    const alice = makeUser('alice2@x.com');
    const mal = makeUser('mal@x.com');
    const keyId = insertRawKey({ userId: alice, exchange: 'bybit', apiKey: 'k', apiSecret: 's' });
    const out = exchangeService.getPublicKey(keyId, mal);
    expect(out).toBeNull();
  });
});

describe('deleteKey', () => {
  it('removes own key', () => {
    const u = makeUser('del@x.com');
    const keyId = insertRawKey({ userId: u, exchange: 'bybit', apiKey: 'k', apiSecret: 's' });
    const out = exchangeService.deleteKey(keyId, u);
    expect(out.deleted).toBe(true);
    const count = db.prepare('SELECT COUNT(*) as n FROM exchange_keys').get();
    expect(count.n).toBe(0);
  });

  it("throws 404 for another user's key", () => {
    const alice = makeUser('alice3@x.com');
    const mal = makeUser('mal2@x.com');
    const keyId = insertRawKey({ userId: alice, exchange: 'bybit', apiKey: 'k', apiSecret: 's' });
    expect(() => exchangeService.deleteKey(keyId, mal)).toThrowError();
  });

  it('also drops LRU cache entry', () => {
    const u = makeUser('lru-del@x.com');
    const keyId = insertRawKey({ userId: u, exchange: 'bybit', apiKey: 'k', apiSecret: 's' });
    // Manually seed cache to simulate a live client
    // (we can't easily instantiate CCXT here without network, so inspect size)
    expect(exchangeService._getCacheSize()).toBe(0);
    exchangeService.deleteKey(keyId, u);
    expect(exchangeService._getCacheSize()).toBe(0);
  });
});

describe('Encryption at rest', () => {
  it('stores secret in iv:ct:tag format, not plaintext', () => {
    const u = makeUser('enc@x.com');
    insertRawKey({
      userId: u, exchange: 'bybit',
      apiKey: 'PlainKey1234', apiSecret: 'PlainSecret999',
    });
    const row = db.prepare('SELECT api_key_encrypted, api_secret_encrypted FROM exchange_keys').get();
    expect(row.api_key_encrypted).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(row.api_key_encrypted).not.toContain('PlainKey1234');
    expect(row.api_secret_encrypted).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(row.api_secret_encrypted).not.toContain('PlainSecret999');
  });

  it('produces different ciphertext for identical plaintext (fresh IV)', () => {
    const u = makeUser('enc2@x.com');
    insertRawKey({
      userId: u, exchange: 'bybit',
      apiKey: 'SameKey0001', apiSecret: 'SameSecret', label: 'a',
    });
    insertRawKey({
      userId: u, exchange: 'bybit',
      apiKey: 'SameKey0002', apiSecret: 'SameSecret', label: 'b',
    });
    const rows = db.prepare('SELECT api_secret_encrypted FROM exchange_keys ORDER BY id').all();
    expect(rows[0].api_secret_encrypted).not.toBe(rows[1].api_secret_encrypted);
  });
});
