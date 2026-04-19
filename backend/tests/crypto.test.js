import { describe, it, expect } from 'vitest';
import crypto from '../utils/crypto.js';

const { encrypt, decrypt, mask, generateKey, sha256, safeEqual } = crypto;

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('crypto.encrypt/decrypt', () => {
  it('round-trips a plain ASCII string', () => {
    const pt = 'hello world';
    const ct = encrypt(pt, TEST_KEY);
    expect(ct).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(decrypt(ct, TEST_KEY)).toBe(pt);
  });

  it('round-trips a realistic Bybit API secret', () => {
    const pt = 'xYz9QrT2bAz9QrT2bAz9QrT2bAz9QrT2bAbCdEfGhIj';
    expect(decrypt(encrypt(pt, TEST_KEY), TEST_KEY)).toBe(pt);
  });

  it('round-trips unicode strings', () => {
    const pt = 'тест 🚀 テスト';
    expect(decrypt(encrypt(pt, TEST_KEY), TEST_KEY)).toBe(pt);
  });

  it('produces different ciphertexts for same plaintext (fresh nonce)', () => {
    const pt = 'same-input';
    const ct1 = encrypt(pt, TEST_KEY);
    const ct2 = encrypt(pt, TEST_KEY);
    expect(ct1).not.toBe(ct2);
    expect(decrypt(ct1, TEST_KEY)).toBe(pt);
    expect(decrypt(ct2, TEST_KEY)).toBe(pt);
  });

  it('rejects 63-char hex key', () => {
    const bad = '0'.repeat(63);
    expect(() => encrypt('x', bad)).toThrow(/64 hex/);
  });

  it('rejects non-hex key', () => {
    const bad = 'z'.repeat(64);
    expect(() => encrypt('x', bad)).toThrow(/64 hex/);
  });

  it('rejects wrong key on decrypt (auth fails)', () => {
    const ct = encrypt('secret', TEST_KEY);
    const wrong = 'f' + TEST_KEY.slice(1);
    expect(() => decrypt(ct, wrong)).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const ct = encrypt('secret', TEST_KEY);
    const parts = ct.split(':');
    const ctBuf = Buffer.from(parts[1], 'base64');
    ctBuf[0] ^= 0x01;
    parts[1] = ctBuf.toString('base64');
    const tampered = parts.join(':');
    expect(() => decrypt(tampered, TEST_KEY)).toThrow();
  });

  it('rejects malformed input', () => {
    expect(() => decrypt('no-colons', TEST_KEY)).toThrow();
    expect(() => decrypt('only:two', TEST_KEY)).toThrow();
    expect(() => decrypt('too:many:colons:here', TEST_KEY)).toThrow();
  });
});

describe('crypto.mask', () => {
  it('masks long values showing last 4', () => {
    expect(mask('abcdef1234')).toBe('••••1234');
  });
  it('returns generic mask for short values', () => {
    expect(mask('ab')).toBe('••••');
    expect(mask('')).toBe('••••');
    expect(mask(null)).toBe('••••');
  });
});

describe('crypto.generateKey', () => {
  it('produces 64 hex chars', () => {
    const k = generateKey();
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
  it('produces different keys each call', () => {
    expect(generateKey()).not.toBe(generateKey());
  });
});

describe('crypto.sha256', () => {
  it('hashes deterministically', () => {
    expect(sha256('hello')).toBe(sha256('hello'));
    expect(sha256('hello')).not.toBe(sha256('world'));
  });
  it('returns 64 hex chars', () => {
    expect(sha256('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('crypto.safeEqual', () => {
  it('returns true for equal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });
  it('returns false for different strings', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
  });
  it('returns false for different lengths', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
