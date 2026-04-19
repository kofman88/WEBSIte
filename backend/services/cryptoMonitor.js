/**
 * Crypto payment monitor — polls BscScan (BEP20) + Tronscan (TRC20) every
 * 60s for incoming USDT transfers matching pending `payments` rows.
 *
 * Matching strategy: find pending payment where amount_usd equals detected
 * transfer amount within ±$0.01. Mark as confirmed.
 *
 * Requirements:
 *   env PAYMENT_BEP20_ADDRESS + BSCSCAN_API_KEY (for BEP20)
 *   env PAYMENT_TRC20_ADDRESS + TRONSCAN_API_KEY (for TRC20)
 *
 * If env missing, that network is silently skipped.
 */

const db = require('../models/database');
const config = require('../config');
const logger = require('../utils/logger');
const paymentService = require('./paymentService');

const USDT_BEP20_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';   // BSC USDT
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';            // TRON USDT
const BSCSCAN_API = 'https://api.bscscan.com/api';
const TRONSCAN_API = 'https://apilist.tronscan.org/api';

let running = false;

async function runOnce() {
  if (running) return { skipped: true };
  running = true;
  try {
    const pending = db.prepare(`
      SELECT * FROM payments
      WHERE status = 'pending' AND (method = 'usdt_bep20' OR method = 'usdt_trc20')
        AND created_at > datetime('now', '-2 hours')
    `).all();
    if (!pending.length) return { matched: 0 };

    let matched = 0;
    const bepTransfers = config.paymentBep20Address && config.bscscanApiKey
      ? await _fetchBep20Transfers().catch(() => []) : [];
    const trcTransfers = config.paymentTrc20Address && config.tronscanApiKey
      ? await _fetchTrc20Transfers().catch(() => []) : [];

    for (const p of pending) {
      const transfers = p.method === 'usdt_bep20' ? bepTransfers : trcTransfers;
      const match = transfers.find((t) =>
        Math.abs(t.amount - Number(p.amount_usd)) < 0.01 &&
        _isRecent(t.timestamp, p.created_at)
      );
      if (match) {
        try {
          paymentService.confirmCryptoPayment(p.id, {
            txHash: match.txHash,
            fromAddress: match.from,
            amountUsdt: match.amount,
          });
          matched++;
          logger.info('crypto payment matched', { paymentId: p.id, tx: match.txHash });
        } catch (err) {
          logger.warn('confirmCryptoPayment failed', { paymentId: p.id, err: err.message });
        }
      }
    }
    return { matched, pendingCount: pending.length };
  } finally {
    running = false;
  }
}

async function _fetchBep20Transfers() {
  const addr = config.paymentBep20Address;
  const url = `${BSCSCAN_API}?module=account&action=tokentx&contractaddress=${USDT_BEP20_CONTRACT}&address=${addr}&startblock=0&endblock=99999999&sort=desc&apikey=${config.bscscanApiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('BscScan HTTP ' + res.status);
  const data = await res.json();
  if (data.status !== '1' || !Array.isArray(data.result)) return [];
  return data.result
    .filter((t) => t.to && t.to.toLowerCase() === addr.toLowerCase())
    .map((t) => ({
      txHash: t.hash,
      from: t.from,
      amount: Number(t.value) / Math.pow(10, Number(t.tokenDecimal) || 18),
      timestamp: Number(t.timeStamp) * 1000,
    }));
}

async function _fetchTrc20Transfers() {
  const addr = config.paymentTrc20Address;
  const url = `${TRONSCAN_API}/token_trc20/transfers?toAddress=${addr}&contract_address=${USDT_TRC20_CONTRACT}&limit=50&sort=-timestamp`;
  const res = await fetch(url, { headers: config.tronscanApiKey ? { 'TRON-PRO-API-KEY': config.tronscanApiKey } : {} });
  if (!res.ok) throw new Error('Tronscan HTTP ' + res.status);
  const data = await res.json();
  const txs = data.token_transfers || data.data || [];
  return txs
    .filter((t) => t.to_address && t.to_address === addr)
    .map((t) => ({
      txHash: t.transaction_id,
      from: t.from_address,
      amount: Number(t.quant) / Math.pow(10, Number(t.tokenInfo?.tokenDecimal || 6)),
      timestamp: Number(t.timestamp),
    }));
}

function _isRecent(txTimestampMs, paymentCreatedAt) {
  const created = new Date(paymentCreatedAt).getTime();
  return txTimestampMs >= created - 300_000; // allow 5-min clock skew
}

let pollTimer = null;
function start(intervalMs = 60_000) {
  if (pollTimer) return;
  logger.info('crypto monitor started', { intervalMs });
  pollTimer = setInterval(() => {
    runOnce().catch((err) => logger.warn('crypto monitor cycle error', { err: err.message }));
  }, intervalMs);
}

function stop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

module.exports = { runOnce, start, stop };
