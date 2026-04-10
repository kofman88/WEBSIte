const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../models/database');
const config = require('../config');

class AuthService {
  /**
   * Register a new user.
   * Optionally link them to a referrer via referralCode.
   */
  register(email, password, referralCode) {
    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingUser) {
      throw new Error('A user with this email already exists');
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const userReferralCode = this._generateReferralCode();

    const result = db.prepare(`
      INSERT INTO users (email, password_hash, referral_code) VALUES (?, ?, ?)
    `).run(email, passwordHash, userReferralCode);

    const userId = result.lastInsertRowid;

    // Handle referral linkage
    if (referralCode) {
      try {
        const referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referralCode);
        if (referrer && referrer.id !== userId) {
          db.prepare(
            `INSERT OR IGNORE INTO referrals (referrer_id, referred_id, commission_pct)
             VALUES (?, ?, 10)`
          ).run(referrer.id, userId);
        }
      } catch (_) {
        // Non-critical: don't fail registration if referral linking fails
      }
    }

    // Auto-create a free subscription row
    try {
      db.prepare(
        `INSERT OR IGNORE INTO subscriptions (user_id, plan, status) VALUES (?, 'free', 'active')`
      ).run(userId);
    } catch (_) {
      // Non-critical
    }

    return {
      userId,
      email,
      referralCode: userReferralCode,
    };
  }

  /**
   * Authenticate a user and return a JWT.
   */
  login(email, password) {
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email);
    if (!user) {
      throw new Error('Invalid email or password');
    }

    const isValid = bcrypt.compareSync(password, user.password_hash);
    if (!isValid) {
      throw new Error('Invalid email or password');
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      config.jwtSecret,
      { expiresIn: '7d' }
    );

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        telegramId: user.telegram_id,
        referralCode: user.referral_code,
        createdAt: user.created_at,
      },
    };
  }

  /**
   * Verify a JWT and return the decoded payload.
   */
  verifyToken(token) {
    try {
      return jwt.verify(token, config.jwtSecret);
    } catch (err) {
      throw new Error('Invalid or expired token');
    }
  }

  /**
   * Get a user by ID (public fields only).
   */
  getUserById(userId) {
    const user = db.prepare(
      'SELECT id, email, telegram_id, referral_code, created_at FROM users WHERE id = ?'
    ).get(userId);
    if (!user) {
      throw new Error('User not found');
    }
    return user;
  }

  /**
   * Generate a unique referral code.
   */
  _generateReferralCode() {
    return 'CHM' + crypto.randomBytes(4).toString('hex').toUpperCase();
  }
}

module.exports = new AuthService();
