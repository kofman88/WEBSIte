/**
 * TON USDT Payment Watcher — автоматическое подтверждение USDT платежей в сети TON.
 *
 * USDT на TON — это jetton (токен). Проверяем через TON Center API v3
 * endpoint /jetton/transfers, который показывает входящие jetton-переводы.
 *
 * Каждые 30 сек: проверяет входящие USDT → если memo = Payment ID → активирует подписку.
 */

const https = require('https');
const db = require('../models/database');

const TON_WALLET = process.env.PAYMENT_WALLET || '';
// USDT jetton master address на TON
const USDT_JETTON = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const CHECK_INTERVAL = 30000;

// Последний проверенный timestamp чтобы не обрабатывать старые tx
let lastCheckedTimestamp = Math.floor(Date.now() / 1000) - 300; // 5 минут назад при старте

/**
 * Получить входящие USDT jetton переводы через TON Center API v3
 */
async function getJettonTransfers() {
  return new Promise((resolve) => {
    if (!TON_WALLET) return resolve([]);

    // TON Center v3 API для jetton transfers
    const url = `https://toncenter.com/api/v3/jetton/transfers?address=${TON_WALLET}&direction=in&limit=20&jetton_master=${USDT_JETTON}`;

    https.get(url, { headers: { 'User-Agent': 'CHM/2.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const transfers = json.jetton_transfers || json.result || [];

          const txs = transfers.map(tx => {
            // USDT на TON имеет 6 decimals
            const amount = parseInt(tx.amount || '0') / 1e6;
            // Forward payload может содержать memo (comment)
            let memo = '';
            if (tx.forward_payload) {
              // Decode text comment from forward_payload
              try {
                if (typeof tx.forward_payload === 'string') {
                  memo = tx.forward_payload;
                } else if (tx.forward_payload.value && tx.forward_payload.value.value) {
                  // Hex encoded text
                  const hex = tx.forward_payload.value.value;
                  memo = Buffer.from(hex, 'hex').toString('utf8').replace(/\0/g, '').trim();
                }
              } catch (_) {}
            }
            // Also check comment field
            if (!memo && tx.comment) memo = tx.comment;

            return {
              hash: tx.transaction_hash || tx.trace_id || '',
              from: tx.source?.address || tx.source || '',
              amount,
              memo,
              timestamp: tx.transaction_now || tx.utime || 0,
            };
          }).filter(tx => tx.amount > 0);

          resolve(txs);
        } catch (e) {
          // Fallback: try v2 API
          getJettonTransfersV2().then(resolve);
        }
      });
    }).on('error', () => {
      getJettonTransfersV2().then(resolve);
    });
  });
}

/**
 * Fallback: проверяем через обычный getTransactions и ищем jetton transfers в out_msgs
 */
async function getJettonTransfersV2() {
  return new Promise((resolve) => {
    const url = `https://toncenter.com/api/v2/getTransactions?address=${TON_WALLET}&limit=30&archival=false`;

    https.get(url, { headers: { 'User-Agent': 'CHM/2.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok || !json.result) return resolve([]);

          const txs = [];
          for (const tx of json.result) {
            // Jetton transfers приходят как internal message с определённым op code
            const inMsg = tx.in_msg;
            if (!inMsg) continue;

            // Проверяем все входящие сообщения
            const value = parseInt(inMsg.value || '0');
            const body = inMsg.message || inMsg.msg_data?.text || '';

            if (body && body.length > 0) {
              txs.push({
                hash: tx.transaction_id?.hash || '',
                from: inMsg.source || '',
                amount: value / 1e6, // Пробуем как jetton (6 dec)
                amountTon: value / 1e9, // Или как TON (9 dec)
                memo: body.trim(),
                timestamp: tx.utime || 0,
              });
            }
          }
          resolve(txs);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

/**
 * Проверить pending платежи
 */
async function checkPendingPayments() {
  if (!TON_WALLET) return;

  const pending = db.prepare(
    "SELECT * FROM payments WHERE status = 'pending' AND expires_at > datetime('now')"
  ).all();

  if (!pending.length) return;

  const txs = await getJettonTransfers();
  if (!txs.length) return;

  for (const payment of pending) {
    const requiredAmount = payment.amount_usd; // USDT = 1:1 с USD
    const minAmount = requiredAmount * 0.98; // 2% допуск

    // Ищем транзакцию с Payment ID в memo
    const match = txs.find(tx => {
      // Проверяем memo
      const memoClean = (tx.memo || '').trim().toUpperCase();
      const payIdClean = payment.payment_id.toUpperCase();
      const memoMatch = memoClean === payIdClean || memoClean.includes(payIdClean);

      // Проверяем сумму (USDT = $1)
      const amountMatch = tx.amount >= minAmount;

      // Только новые транзакции
      const isNew = tx.timestamp > lastCheckedTimestamp - 60;

      return memoMatch && amountMatch && isNew;
    });

    if (match) {
      console.log(`[USDT-WATCHER] MATCH! ${payment.payment_id}: $${match.amount} USDT from ${match.from.slice(0, 12)}...`);

      try {
        const paymentService = require('./paymentService');
        paymentService.confirmPayment(payment.payment_id, match.hash);
        console.log(`[USDT-WATCHER] Subscription activated: ${payment.plan} for user ${payment.user_id}`);
      } catch (e) {
        console.error(`[USDT-WATCHER] Confirm error: ${e.message}`);
      }
    }
  }

  // Обновляем timestamp
  lastCheckedTimestamp = Math.floor(Date.now() / 1000);

  // Закрываем просроченные
  db.prepare(
    "UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at <= datetime('now')"
  ).run();
}

let watcherTimer = null;

function startTonWatcher() {
  if (!TON_WALLET) {
    console.log('[USDT-WATCHER] No PAYMENT_WALLET configured, skipping...');
    return;
  }
  console.log(`[USDT-WATCHER] Started — watching USDT on TON at ${TON_WALLET.slice(0, 12)}... every ${CHECK_INTERVAL / 1000}s`);

  setTimeout(() => checkPendingPayments().catch(e => console.error('[USDT-WATCHER]', e.message)), 10000);

  watcherTimer = setInterval(() => {
    checkPendingPayments().catch(e => console.error('[USDT-WATCHER]', e.message));
  }, CHECK_INTERVAL);
}

function stopTonWatcher() {
  if (watcherTimer) clearInterval(watcherTimer);
  console.log('[USDT-WATCHER] Stopped');
}

module.exports = { startTonWatcher, stopTonWatcher, checkPendingPayments };
