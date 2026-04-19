#!/usr/bin/env node
/**
 * Seed helper — creates:
 *   1 admin user   (admin@chm.local, password from env or 'admin123456')
 *   1 regular user (test@chm.local,  password 'test12345')  with Pro plan
 *   1 promo code   (WELCOME2026 → Pro 30 days, 100 uses)
 *
 * Idempotent: re-running doesn't duplicate rows.
 *
 * Usage: npm run db:seed
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../models/database');

function makeRefCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function ensureUser({ email, password, isAdmin = 0, plan = 'free' }) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    console.log('•  user exists:', email, '(id=' + existing.id + ')');
    return existing.id;
  }
  const hash = bcrypt.hashSync(password, 12);
  const refCode = makeRefCode();
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, referral_code, is_admin, email_verified)
    VALUES (?, ?, ?, ?, 1)
  `).run(email, hash, refCode, isAdmin);
  const userId = result.lastInsertRowid;

  const expires = plan === 'free' ? null
    : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  db.prepare(`
    INSERT INTO subscriptions (user_id, plan, status, expires_at)
    VALUES (?, ?, 'active', ?)
  `).run(userId, plan, expires);

  console.log('✓  created user:', email, 'plan=' + plan, 'refCode=' + refCode, '(id=' + userId + ')');
  return userId;
}

function ensurePromo(code, { plan = 'pro', days = 30, maxUses = 100 } = {}) {
  const existing = db.prepare('SELECT id FROM promo_codes WHERE code = ?').get(code);
  if (existing) {
    console.log('•  promo exists:', code);
    return existing.id;
  }
  const result = db.prepare(`
    INSERT INTO promo_codes (code, plan, duration_days, max_uses, is_active)
    VALUES (?, ?, ?, ?, 1)
  `).run(code, plan, days, maxUses);
  console.log('✓  created promo:', code, '→', plan, days + 'd', 'x' + maxUses);
  return result.lastInsertRowid;
}

const adminPass = process.env.SEED_ADMIN_PASSWORD || 'admin123456';
const testPass  = process.env.SEED_TEST_PASSWORD  || 'test12345';

ensureUser({ email: 'admin@chm.local', password: adminPass, isAdmin: 1, plan: 'elite' });
ensureUser({ email: 'test@chm.local',  password: testPass,  isAdmin: 0, plan: 'pro'   });
ensurePromo('WELCOME2026', { plan: 'pro', days: 30, maxUses: 100 });

console.log('\n✅ Seed complete.');
console.log('   Admin: admin@chm.local /', adminPass);
console.log('   Test:  test@chm.local  /', testPass);
console.log('   Promo: WELCOME2026 (Pro 30d, 100 uses)\n');

db.close();
