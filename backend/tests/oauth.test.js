/**
 * OAuth service tests — Telegram HMAC verify + account upsert/linking.
 *
 * Google OAuth is HTTP-heavy (3 real requests to Google). We skip live
 * google tests and cover only the HMAC/state/upsert logic that's
 * runnable offline.
 */

import { describe, it, expect, beforeEach } from 'vitest';
const crypto = require('crypto');
const db = require('../models/database');

// Bot token must be set BEFORE oauthService is required, because the
// config resolver inspects env vars eagerly via process.env reads.
const BOT_TOKEN = 'test-bot-token-7890:AAEabc';
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.TELEGRAM_BOT_USERNAME = 'TestBot';

const oauth = require('../services/oauthService');

function mkTgPayload({ id = 12345, firstName = 'Alex', lastName = 'Smith', username = 'alex' } = {}) {
  const data = {
    id,
    first_name: firstName,
    last_name: lastName,
    username,
    auth_date: Math.floor(Date.now() / 1000),
  };
  const checkStr = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
  return { ...data, hash };
}

beforeEach(() => {
  db.prepare('DELETE FROM trading_bots').run();
  db.prepare('DELETE FROM refresh_tokens').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
});

describe('providers()', () => {
  it('telegram enabled when TELEGRAM_BOT_TOKEN set', () => {
    const p = oauth.providers();
    expect(p.telegram.enabled).toBe(true);
    expect(p.telegram.username).toBe('TestBot');
  });

  it('google disabled when GOOGLE_OAUTH_CLIENT_ID absent', () => {
    const save = process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    const p = oauth.providers();
    expect(p.google.enabled).toBe(false);
    if (save) process.env.GOOGLE_OAUTH_CLIENT_ID = save;
  });
});

describe('verifyTelegram()', () => {
  it('accepts a correctly-signed payload', () => {
    const ok = oauth.verifyTelegram(mkTgPayload());
    expect(ok.tgId).toBe('12345');
    expect(ok.firstName).toBe('Alex');
  });

  it('rejects tampered hash', () => {
    const bad = { ...mkTgPayload(), hash: '00'.repeat(32) };
    expect(() => oauth.verifyTelegram(bad)).toThrowError(/signature/i);
  });

  it('rejects tampered payload with a different field', () => {
    const p = mkTgPayload();
    p.first_name = 'Mallory'; // hash was computed over 'Alex'
    expect(() => oauth.verifyTelegram(p)).toThrowError(/signature/i);
  });

  it('rejects stale auth_date (>24h)', () => {
    const p = mkTgPayload();
    p.auth_date = Math.floor(Date.now() / 1000) - 86400 - 60;
    // Recompute hash over the stale date so signature alone passes
    const checkStr = Object.keys(p).filter((k) => k !== 'hash').sort()
      .map((k) => `${k}=${p[k]}`).join('\n');
    const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
    p.hash = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
    expect(() => oauth.verifyTelegram(p)).toThrowError(/too old/i);
  });

  it('rejects missing id or hash', () => {
    expect(() => oauth.verifyTelegram({})).toThrowError(/Invalid/);
    expect(() => oauth.verifyTelegram({ id: 1 })).toThrowError(/Invalid/);
  });
});

describe('upsertOAuthUser()', () => {
  it('creates a new user when no match exists', () => {
    const user = oauth.upsertOAuthUser({
      provider: 'google',
      providerId: 'google-sub-AAA',
      email: 'new@example.com',
      emailVerified: true,
      givenName: 'Alex',
      familyName: 'Smith',
      avatarUrl: 'https://example.com/a.jpg',
    });
    expect(user.email).toBe('new@example.com');
    expect(user.google_id).toBe('google-sub-AAA');
    expect(user.given_name).toBe('Alex');
    expect(user.oauth_provider).toBe('google');
  });

  it('links to an existing email user, keeps the original id', () => {
    // Pre-create a password user with the same email
    const existing = db.prepare(`
      INSERT INTO users (email, password_hash, referral_code, email_verified, is_active, oauth_provider)
      VALUES ('same@example.com', 'x', 'CODE1', 0, 1, 'password')
    `).run();
    const user = oauth.upsertOAuthUser({
      provider: 'google',
      providerId: 'google-sub-BBB',
      email: 'same@example.com',
      emailVerified: true,
      givenName: 'Alex',
    });
    expect(user.id).toBe(existing.lastInsertRowid);      // kept
    expect(user.google_id).toBe('google-sub-BBB');       // linked
    expect(user.email_verified).toBe(1);                 // upgraded by OAuth
  });

  it('returns the same row on subsequent calls with the same google_id', () => {
    const u1 = oauth.upsertOAuthUser({
      provider: 'google', providerId: 'sub-C', email: 'c@x.com',
    });
    const u2 = oauth.upsertOAuthUser({
      provider: 'google', providerId: 'sub-C', email: 'c@x.com',
    });
    expect(u2.id).toBe(u1.id);
  });

  it('creates Telegram user without email (synthetic @chm.local)', () => {
    const user = oauth.upsertOAuthUser({
      provider: 'telegram',
      providerId: '77777',
      email: null,
      givenName: 'Ivan',
      tgUsername: 'ivanov',
    });
    expect(user.tg_id).toBe('77777');
    expect(user.email).toMatch(/telegram_77777@chm\.local/);
    expect(user.oauth_provider).toBe('telegram');
  });

  it('duplicate Telegram id on a different email is prevented by unique index', () => {
    oauth.upsertOAuthUser({ provider: 'telegram', providerId: '99', email: null });
    // A raw INSERT with the same tg_id should fail the unique partial index
    expect(() => {
      db.prepare(`
        INSERT INTO users (email, password_hash, referral_code, is_active, oauth_provider, tg_id)
        VALUES ('another@x.com', '', 'DUPE', 1, 'password', '99')
      `).run();
    }).toThrowError(/UNIQUE/);
  });
});

describe('state token', () => {
  it('roundtrips a state through issue + verify', () => {
    const s = oauth.issueState();
    expect(oauth.verifyState(s)).toBe(true);
  });

  it('rejects a state with a tampered signature', () => {
    const s = oauth.issueState();
    const parts = s.split('.');
    parts[2] = '00'.repeat(12);
    expect(oauth.verifyState(parts.join('.'))).toBe(false);
  });

  it('rejects a state older than 10 minutes', () => {
    // Synthesize an old state directly
    const nonce = 'abcdef'.padEnd(24, '0');
    const ts = Date.now() - 11 * 60 * 1000;
    const sig = require('crypto')
      .createHmac('sha256', process.env.JWT_SECRET || 'dev')
      .update(nonce + ':' + ts).digest('hex').slice(0, 24);
    expect(oauth.verifyState(`${nonce}.${ts}.${sig}`)).toBe(false);
  });
});
