const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../models/database');
const config = require('../config');

class AuthService {
  register(email, password, referralCode) {
    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingUser) {
      throw new Error('Пользователь с таким email уже существует');
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const userReferralCode = this._generateReferralCode();
    const emailVerifyToken = crypto.randomBytes(32).toString('hex');

    const result = db.prepare(
      `INSERT INTO users (email, password_hash, referral_code, email_verify_token, email_verified)
       VALUES (?, ?, ?, ?, 0)`
    ).run(email, passwordHash, userReferralCode, emailVerifyToken);

    const userId = result.lastInsertRowid;

    if (referralCode) {
      try {
        const referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referralCode);
        if (referrer && referrer.id !== userId) {
          db.prepare(
            `INSERT OR IGNORE INTO referrals (referrer_id, referred_id, commission_pct) VALUES (?, ?, 10)`
          ).run(referrer.id, userId);
        }
      } catch (_) {}
    }

    try {
      db.prepare(
        `INSERT OR IGNORE INTO subscriptions (user_id, plan, status) VALUES (?, 'free', 'active')`
      ).run(userId);
    } catch (_) {}

    return { userId, email, referralCode: userReferralCode, emailVerifyToken };
  }

  login(email, password) {
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email);
    if (!user) throw new Error('Неверный email или пароль');

    const isValid = bcrypt.compareSync(password, user.password_hash);
    if (!isValid) throw new Error('Неверный email или пароль');

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
        emailVerified: !!user.email_verified,
        createdAt: user.created_at,
      },
    };
  }

  verifyEmail(token) {
    const user = db.prepare('SELECT id FROM users WHERE email_verify_token = ?').get(token);
    if (!user) throw new Error('Invalid verification token');
    db.prepare('UPDATE users SET email_verified = 1, email_verify_token = NULL WHERE id = ?').run(user.id);
    return { verified: true };
  }

  requestPasswordReset(email) {
    const user = db.prepare('SELECT id FROM users WHERE email = ? AND is_active = 1').get(email);
    if (!user) throw new Error('If this email exists, a reset link has been sent');

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 3600000).toISOString(); // 1 hour

    db.prepare(
      'UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?'
    ).run(resetToken, resetExpires, user.id);

    return { resetToken, email };
  }

  resetPassword(token, newPassword) {
    const user = db.prepare(
      'SELECT id, reset_expires FROM users WHERE reset_token = ?'
    ).get(token);

    if (!user) throw new Error('Invalid or expired reset token');
    if (new Date(user.reset_expires) < new Date()) throw new Error('Reset token has expired');
    if (newPassword.length < 6) throw new Error('Password must be at least 6 characters');

    const passwordHash = bcrypt.hashSync(newPassword, 10);
    db.prepare(
      'UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?'
    ).run(passwordHash, user.id);

    return { success: true };
  }

  changePassword(userId, currentPassword, newPassword) {
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('User not found');

    const isValid = bcrypt.compareSync(currentPassword, user.password_hash);
    if (!isValid) throw new Error('Current password is incorrect');
    if (newPassword.length < 6) throw new Error('New password must be at least 6 characters');

    const passwordHash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(passwordHash, userId);
    return { success: true };
  }

  verifyToken(token) {
    try {
      return jwt.verify(token, config.jwtSecret);
    } catch (err) {
      throw new Error('Invalid or expired token');
    }
  }

  getUserById(userId) {
    const user = db.prepare(
      'SELECT id, email, telegram_id, referral_code, email_verified, created_at FROM users WHERE id = ?'
    ).get(userId);
    if (!user) throw new Error('User not found');
    return user;
  }

  _generateReferralCode() {
    return 'CHM' + crypto.randomBytes(4).toString('hex').toUpperCase();
  }
}

module.exports = new AuthService();
