const crypto = require('crypto');
const db = require('../models/database');
const config = require('../config');

const ALGORITHM = 'aes-256-cbc';

class WalletService {
  // ── Encryption helpers ─────────────────────────────────────────────────

  /**
   * Encrypt a plaintext string using AES-256-CBC.
   * Returns a hex-encoded string of iv:encrypted.
   */
  _encrypt(plaintext) {
    const key = Buffer.from(config.walletEncryptionKey, 'utf8').slice(0, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  /**
   * Decrypt a hex-encoded iv:encrypted string.
   */
  _decrypt(encryptedPayload) {
    const key = Buffer.from(config.walletEncryptionKey, 'utf8').slice(0, 32);
    const parts = encryptedPayload.split(':');
    if (parts.length !== 2) {
      throw new Error('Invalid encrypted payload format');
    }
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Generate a deterministic-looking but random wallet address.
   * In production this would use a real blockchain SDK.
   */
  _generateAddress() {
    return '0x' + crypto.randomBytes(20).toString('hex');
  }

  /**
   * Generate a random private key placeholder.
   * In production this would be a real private key from the blockchain SDK.
   */
  _generatePrivateKey() {
    return crypto.randomBytes(32).toString('hex');
  }

  // ── Wallet CRUD ────────────────────────────────────────────────────────

  /**
   * Create a custodial wallet for the user.
   * Each user can have at most one wallet.
   */
  createWallet(userId) {
    const existing = db
      .prepare('SELECT id FROM wallets WHERE user_id = ?')
      .get(userId);

    if (existing) {
      throw new Error('Wallet already exists for this user');
    }

    const address = this._generateAddress();
    const privateKey = this._generatePrivateKey();
    const encryptedKey = this._encrypt(privateKey);

    db.prepare(
      `INSERT INTO wallets (user_id, address, encrypted_private_key, balance)
       VALUES (?, ?, ?, 0)`
    ).run(userId, address, encryptedKey);

    const wallet = db
      .prepare('SELECT id, user_id, address, balance, created_at FROM wallets WHERE user_id = ?')
      .get(userId);

    return wallet;
  }

  /**
   * Get the wallet for a user (public fields only).
   */
  getWallet(userId) {
    const wallet = db
      .prepare('SELECT id, user_id, address, balance, created_at, updated_at FROM wallets WHERE user_id = ?')
      .get(userId);

    if (!wallet) {
      return null;
    }

    return wallet;
  }

  /**
   * Get the wallet balance.
   */
  getBalance(userId) {
    const wallet = this.getWallet(userId);
    if (!wallet) {
      throw new Error('No wallet found. Create one first.');
    }

    // Also gather pending deposit/withdrawal sums
    const pendingDeposits = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM wallet_transactions
         WHERE user_id = ? AND type = 'deposit' AND status = 'pending'`
      )
      .get(userId).total;

    const pendingWithdrawals = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM wallet_transactions
         WHERE user_id = ? AND type = 'withdrawal' AND status IN ('pending', 'processing')`
      )
      .get(userId).total;

    return {
      address: wallet.address,
      balance: wallet.balance,
      pendingDeposits,
      pendingWithdrawals,
      availableBalance: wallet.balance - pendingWithdrawals,
    };
  }

  // ── Transactions ───────────────────────────────────────────────────────

  /**
   * Request a withdrawal.
   */
  requestWithdrawal(userId, { amount, destinationAddress }) {
    if (!amount || amount <= 0) {
      throw new Error('Withdrawal amount must be greater than 0');
    }

    if (!destinationAddress || typeof destinationAddress !== 'string' || destinationAddress.length < 10) {
      throw new Error('A valid destination address is required');
    }

    const wallet = db
      .prepare('SELECT * FROM wallets WHERE user_id = ?')
      .get(userId);

    if (!wallet) {
      throw new Error('No wallet found. Create one first.');
    }

    // Check pending withdrawals
    const pendingWithdrawals = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM wallet_transactions
         WHERE user_id = ? AND type = 'withdrawal' AND status IN ('pending', 'processing')`
      )
      .get(userId).total;

    const available = wallet.balance - pendingWithdrawals;
    if (amount > available) {
      throw new Error(`Insufficient balance. Available: ${available.toFixed(2)}, requested: ${amount.toFixed(2)}`);
    }

    const txHash = 'tx_' + crypto.randomBytes(16).toString('hex');

    db.prepare(
      `INSERT INTO wallet_transactions (user_id, wallet_id, type, amount, tx_hash, destination_address, status)
       VALUES (?, ?, 'withdrawal', ?, ?, ?, 'pending')`
    ).run(userId, wallet.id, amount, txHash, destinationAddress);

    const tx = db
      .prepare('SELECT * FROM wallet_transactions WHERE tx_hash = ?')
      .get(txHash);

    return tx;
  }

  /**
   * Process a deposit (admin / internal use).
   */
  processDeposit(userId, { amount, txHash, notes }) {
    if (!amount || amount <= 0) {
      throw new Error('Deposit amount must be greater than 0');
    }

    const wallet = db
      .prepare('SELECT * FROM wallets WHERE user_id = ?')
      .get(userId);

    if (!wallet) {
      throw new Error('No wallet found for this user');
    }

    const depositTx = db.transaction(() => {
      db.prepare(
        `INSERT INTO wallet_transactions (user_id, wallet_id, type, amount, tx_hash, status, notes)
         VALUES (?, ?, 'deposit', ?, ?, 'completed', ?)`
      ).run(userId, wallet.id, amount, txHash || 'int_' + crypto.randomBytes(8).toString('hex'), notes || null);

      db.prepare(
        `UPDATE wallets SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
      ).run(amount, userId);
    });

    depositTx();

    return this.getBalance(userId);
  }

  /**
   * Complete a pending withdrawal (admin / cron job).
   */
  completeWithdrawal(transactionId) {
    const tx = db
      .prepare('SELECT * FROM wallet_transactions WHERE id = ? AND type = ? AND status = ?')
      .get(transactionId, 'withdrawal', 'pending');

    if (!tx) {
      throw new Error('Pending withdrawal transaction not found');
    }

    const process = db.transaction(() => {
      db.prepare(
        `UPDATE wallet_transactions SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(transactionId);

      db.prepare(
        `UPDATE wallets SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
      ).run(tx.amount, tx.user_id);
    });

    process();

    return db
      .prepare('SELECT * FROM wallet_transactions WHERE id = ?')
      .get(transactionId);
  }

  /**
   * Cancel a pending withdrawal.
   */
  cancelWithdrawal(userId, transactionId) {
    const tx = db
      .prepare(
        'SELECT * FROM wallet_transactions WHERE id = ? AND user_id = ? AND type = ? AND status = ?'
      )
      .get(transactionId, userId, 'withdrawal', 'pending');

    if (!tx) {
      throw new Error('Pending withdrawal not found or already processed');
    }

    db.prepare(
      `UPDATE wallet_transactions SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(transactionId);

    return db
      .prepare('SELECT * FROM wallet_transactions WHERE id = ?')
      .get(transactionId);
  }

  /**
   * Get transaction history for a user.
   */
  getTransactions(userId, options = {}) {
    const { page = 1, limit = 20, type, status } = options;

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ['user_id = ?'];
    const params = [userId];

    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countRow = db
      .prepare(`SELECT COUNT(*) as total FROM wallet_transactions ${where}`)
      .get(...params);

    const transactions = db
      .prepare(
        `SELECT * FROM wallet_transactions ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, safeLimit, offset);

    return {
      transactions,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: countRow.total,
        totalPages: Math.ceil(countRow.total / safeLimit),
      },
    };
  }
}

module.exports = new WalletService();
