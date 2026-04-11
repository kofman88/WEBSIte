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

const PAYMENT_METHODS = {
  ton: {
    wallet: process.env.PAYMENT_WALLET || '',
    network: 'TON',
    networkFull: 'The Open Network (TON)',
    currency: 'TON',
    note: 'Отправьте точную сумму в TON. В комментарий (memo) укажите Payment ID.',
  },
  usdt_trc20: {
    wallet: process.env.PAYMENT_WALLET_TRC20 || process.env.PAYMENT_WALLET || '',
    network: 'TRC-20',
    networkFull: 'TRON (TRC-20)',
    currency: 'USDT',
    note: 'Сеть: TRC-20 (TRON). Убедитесь что выбрали правильную сеть!',
  },
  usdt_polygon: {
    wallet: process.env.PAYMENT_WALLET_POLYGON || '',
    network: 'Polygon',
    networkFull: 'Polygon (MATIC)',
    currency: 'USDT',
    note: 'Сеть: Polygon. Низкие комиссии.',
  },
};

class PaymentService {
  getPaymentMethods() {
    return Object.entries(PAYMENT_METHODS)
      .filter(([, v]) => v.wallet)
      .map(([id, v]) => ({ id, ...v }));
  }

  createPayment(userId, plan, method = 'ton') {
    if (!PLAN_PRICES[plan]) throw new Error('Invalid plan');
    const pm = PAYMENT_METHODS[method];
    if (!pm || !pm.wallet) throw new Error('Invalid payment method');

    const paymentId = 'PAY-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    const amount = PLAN_PRICES[plan];
    const expiresAt = new Date(Date.now() + 3600000).toISOString();

    db.prepare(
      `INSERT INTO payments (payment_id, user_id, plan, amount_usd, currency, wallet_address, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(paymentId, userId, plan, amount, pm.currency, pm.wallet, expiresAt);

    return {
      paymentId,
      plan,
      amount,
      currency: pm.currency,
      network: pm.network,
      networkFull: pm.networkFull,
      walletAddress: pm.wallet,
      memo: paymentId,
      note: pm.note,
      expiresAt,
      qrData: `${pm.currency.toLowerCase()}:${pm.wallet}?amount=${amount}&memo=${paymentId}`,
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
