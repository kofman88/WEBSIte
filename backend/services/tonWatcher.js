/**
 * TON Payment Watcher — автоматическое подтверждение платежей.
 *
 * Каждые 30 сек проверяет входящие транзакции на TON кошелёк через TON Center API.
 * Если находит транзакцию с memo = Payment ID и правильной суммой — активирует подписку.
 *
 * Бесплатно, без комиссий, полный контроль.
 */

const https = require('https');
const db = require('../models/database');

const TON_WALLET = process.env.PAYMENT_WALLET || '';
const TON_API = 'https://toncenter.com/api/v2';
const CHECK_INTERVAL = 30000; // 30 секунд

// Курс TON/USD — обновляется каждые 5 минут
let tonPriceUsd = 0;
let lastPriceUpdate = 0;

async function fetchTonPrice() {
  return new Promise((resolve) => {
    https.get('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd', {
      headers: { 'User-Agent': 'CHM/2.0' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          tonPriceUsd = json['the-open-network']?.usd || 0;
          lastPriceUpdate = Date.now();
          resolve(tonPriceUsd);
        } catch (e) { resolve(tonPriceUsd); }
      });
    }).on('error', () => resolve(tonPriceUsd));
  });
}

async function getTonPrice() {
  if (Date.now() - lastPriceUpdate > 300000 || !tonPriceUsd) { // 5 min cache
    await fetchTonPrice();
  }
  return tonPriceUsd;
}

/**
 * Получить последние транзакции на наш кошелёк
 */
async function getIncomingTransactions(limit = 20) {
  return new Promise((resolve) => {
    if (!TON_WALLET) return resolve([]);

    const url = `${TON_API}/getTransactions?address=${TON_WALLET}&limit=${limit}&archival=false`;
    https.get(url, { headers: { 'User-Agent': 'CHM/2.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok || !json.result) return resolve([]);

          const txs = json.result
            .filter(tx => tx.in_msg && tx.in_msg.value && parseInt(tx.in_msg.value) > 0)
            .map(tx => ({
              hash: tx.transaction_id?.hash || '',
              from: tx.in_msg.source || '',
              amount: parseInt(tx.in_msg.value) / 1e9, // nanoton → TON
              memo: tx.in_msg.message || '',
              timestamp: tx.utime || 0,
            }));

          resolve(txs);
        } catch (e) {
          console.error('[TON-WATCHER] Parse error:', e.message);
          resolve([]);
        }
      });
    }).on('error', (e) => {
      console.error('[TON-WATCHER] Fetch error:', e.message);
      resolve([]);
    });
  });
}

/**
 * Проверить pending платежи и подтвердить если нашли транзакцию
 */
async function checkPendingPayments() {
  if (!TON_WALLET) return;

  const pending = db.prepare(
    "SELECT * FROM payments WHERE status = 'pending' AND expires_at > datetime('now')"
  ).all();

  if (!pending.length) return;

  const tonPrice = await getTonPrice();
  if (!tonPrice) {
    console.log('[TON-WATCHER] Cannot get TON price, skipping...');
    return;
  }

  const txs = await getIncomingTransactions(30);
  if (!txs.length) return;

  for (const payment of pending) {
    // Сколько TON нужно заплатить
    const requiredTon = payment.amount_usd / tonPrice;
    const minTon = requiredTon * 0.95; // 5% допуск на курс

    // Ищем транзакцию с нашим Payment ID в memo
    const matchingTx = txs.find(tx => {
      const memoMatch = tx.memo.trim().toUpperCase() === payment.payment_id.toUpperCase();
      const amountMatch = tx.amount >= minTon;
      // Только транзакции за последний час
      const recentEnough = tx.timestamp > (Date.now() / 1000 - 3600);
      return memoMatch && amountMatch && recentEnough;
    });

    if (matchingTx) {
      console.log(`[TON-WATCHER] MATCH! Payment ${payment.payment_id}: ${matchingTx.amount} TON from ${matchingTx.from}`);

      try {
        // Подтверждаем платёж
        const paymentService = require('./paymentService');
        paymentService.confirmPayment(payment.payment_id, matchingTx.hash);
        console.log(`[TON-WATCHER] Subscription activated: ${payment.plan} for user ${payment.user_id}`);
      } catch (e) {
        console.error(`[TON-WATCHER] Confirm error: ${e.message}`);
      }
    }
  }

  // Закрываем просроченные
  db.prepare(
    "UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at <= datetime('now')"
  ).run();
}

let watcherTimer = null;

function startTonWatcher() {
  if (!TON_WALLET) {
    console.log('[TON-WATCHER] No PAYMENT_WALLET configured, skipping...');
    return;
  }
  console.log(`[TON-WATCHER] Started — watching ${TON_WALLET.slice(0, 8)}... every ${CHECK_INTERVAL / 1000}s`);

  // Первая проверка через 10 сек
  setTimeout(() => checkPendingPayments().catch(e => console.error('[TON-WATCHER]', e.message)), 10000);

  watcherTimer = setInterval(() => {
    checkPendingPayments().catch(e => console.error('[TON-WATCHER]', e.message));
  }, CHECK_INTERVAL);
}

function stopTonWatcher() {
  if (watcherTimer) clearInterval(watcherTimer);
  console.log('[TON-WATCHER] Stopped');
}

module.exports = { startTonWatcher, stopTonWatcher, checkPendingPayments, getTonPrice };
