/**
 * Portfolio — aggregated balances across all user's exchange keys.
 *
 * Cached per-user for 60s in system_kv to avoid hammering exchange APIs
 * on every page render. ccxt fetchBalance is slow (500-2000ms) so we never
 * want to call it synchronously on a request if we can help it.
 */

const db = require('../models/database');
const exchangeService = require('./exchangeService');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 60 * 1000;

function cacheGet(userId) {
  const row = db.prepare("SELECT value FROM system_kv WHERE key = ?").get('portfolio:' + userId);
  if (!row) return null;
  try {
    const { ts, data } = JSON.parse(row.value);
    if (Date.now() - ts > CACHE_TTL_MS) return null;
    return data;
  } catch { return null; }
}
function cachePut(userId, data) {
  db.prepare(`INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`)
    .run('portfolio:' + userId, JSON.stringify({ ts: Date.now(), data }));
}

async function getForUser(userId, { fresh = false } = {}) {
  if (!fresh) {
    const cached = cacheGet(userId);
    if (cached) return { ...cached, cached: true };
  }

  const keys = db.prepare(`
    SELECT id, exchange, label, is_active FROM exchange_keys
    WHERE user_id = ? AND is_active = 1
  `).all(userId);

  const perExchange = [];
  let totalUsdt = 0;
  let anyError = false;

  await Promise.all(keys.map(async (k) => {
    try {
      const balance = await exchangeService.getBalance(userId, k.id);
      // ccxt returns { USDT: {free, used, total}, BTC: {...}, ... }
      const coins = [];
      let exchangeUsdt = 0;
      for (const [symbol, b] of Object.entries(balance || {})) {
        if (!b || typeof b.total !== 'number' || b.total <= 0) continue;
        coins.push({ symbol, free: b.free || 0, used: b.used || 0, total: b.total });
        if (symbol === 'USDT' || symbol === 'USDC' || symbol === 'BUSD') exchangeUsdt += b.total;
      }
      coins.sort((a, b) => b.total - a.total);
      perExchange.push({
        keyId: k.id, exchange: k.exchange, label: k.label || k.exchange,
        coins: coins.slice(0, 20), totalUsdt: exchangeUsdt,
      });
      totalUsdt += exchangeUsdt;
    } catch (err) {
      anyError = true;
      perExchange.push({
        keyId: k.id, exchange: k.exchange, label: k.label || k.exchange,
        coins: [], totalUsdt: 0, error: err.message,
      });
      logger.warn('portfolio fetchBalance failed', { userId, keyId: k.id, err: err.message });
    }
  }));

  const result = {
    totalUsdt: Math.round(totalUsdt * 100) / 100,
    exchanges: perExchange,
    fetchedAt: new Date().toISOString(),
    partial: anyError,
  };
  cachePut(userId, result);
  return { ...result, cached: false };
}

module.exports = { getForUser };
