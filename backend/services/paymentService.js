const crypto = require('crypto');
const db = require('../models/database');

/**
 * Payment service for crypto payments (TON, USDT).
 *
 * Flow:
 * 1. User requests payment → gets unique payment ID + wallet address
 * 2. User sends crypto to the address with payment ID in memo
 * 3. Backend verifies payment (manual or webhook)
 * 4. Subscription activated
 */

// Create payments table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      plan TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USDT',
      status TEXT NOT NULL DEFAULT 'pending',
      tx_hash TEXT,
      wallet_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      expires_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_payments_id ON payments(payment_id);
  `);
} catch (_) {}

const PLAN_PRICES = {
  starter: 29,
  pro: 79,
  elite: 149,
};

const PAYMENT_WALLET = process.env.PAYMENT_WALLET || 'UQBxxxxxx'; // TON wallet

class PaymentService {
  createPayment(userId, plan, currency = 'USDT') {
    if (!PLAN_PRICES[plan]) throw new Error('Invalid plan');

    const paymentId = 'PAY-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    const amount = PLAN_PRICES[plan];
    const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour

    db.prepare(
      `INSERT INTO payments (payment_id, user_id, plan, amount_usd, currency, wallet_address, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(paymentId, userId, plan, amount, currency, PAYMENT_WALLET, expiresAt);

    return {
      paymentId,
      plan,
      amount,
      currency,
      walletAddress: PAYMENT_WALLET,
      memo: paymentId,
      expiresAt,
    };
  }

  getPayment(paymentId) {
    return db.prepare('SELECT * FROM payments WHERE payment_id = ?').get(paymentId);
  }

  getUserPayments(userId) {
    return db.prepare(
      'SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
    ).all(userId);
  }

  // Called when payment is confirmed (manually or via webhook)
  confirmPayment(paymentId, txHash) {
    const payment = this.getPayment(paymentId);
    if (!payment) throw new Error('Payment not found');
    if (payment.status === 'completed') throw new Error('Payment already completed');

    const apply = db.transaction(() => {
      // Update payment status
      db.prepare(
        `UPDATE payments SET status = 'completed', tx_hash = ?, completed_at = CURRENT_TIMESTAMP WHERE payment_id = ?`
      ).run(txHash || 'manual', paymentId);

      // Activate subscription
      const subscriptionService = require('./subscriptionService');
      subscriptionService.activateSubscription(payment.user_id, {
        plan: payment.plan,
        paymentMethod: payment.currency,
        paymentTx: paymentId,
        durationDays: 30,
      });
    });

    apply();
    return { success: true, plan: payment.plan };
  }

  cancelExpiredPayments() {
    db.prepare(
      `UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at < CURRENT_TIMESTAMP`
    ).run();
  }
}

module.exports = new PaymentService();
