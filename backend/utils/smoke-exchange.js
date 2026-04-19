#!/usr/bin/env node
/**
 * Smoke test for exchange layer — requires real network access.
 *
 * Tests (in order):
 *  1. List supported exchanges
 *  2. Fetch Bybit symbols (public, no key)
 *  3. Fetch BTC/USDT ticker
 *  4. Fetch 10 candles BTC/USDT 1h
 *  5. If BYBIT_TESTNET_API_KEY set — add key, list, verify, get balance, delete
 *
 * Usage:
 *   node utils/smoke-exchange.js
 *   BYBIT_TESTNET_API_KEY=... BYBIT_TESTNET_API_SECRET=... node utils/smoke-exchange.js
 */

const path = require('path');
process.env.DATABASE_PATH = path.join(__dirname, '..', 'data', 'smoke.db');
process.env.DB_QUIET = '1';

(async () => {
  const exchangeService = require('../services/exchangeService');
  const marketData = require('../services/marketDataService');
  const db = require('../models/database');

  function log(step, msg) {
    console.log('[' + step + '] ' + msg);
  }

  log('1', 'Supported: ' + exchangeService.listSupported().join(', '));

  log('2', 'Fetching Bybit symbols...');
  const syms = await marketData.fetchSymbols('bybit');
  log('2', 'Got ' + syms.length + ' symbols. First: ' + syms[0].symbol);

  log('3', 'Fetching BTC/USDT ticker...');
  const t = await marketData.fetchTicker('bybit', 'BTC/USDT');
  log('3', 'Last price: ' + t.last + ' bid: ' + t.bid + ' ask: ' + t.ask);

  log('4', 'Fetching 10 candles 1h...');
  const candles = await marketData.fetchCandles('bybit', 'BTC/USDT', '1h', { limit: 10 });
  log('4', 'Got ' + candles.length + ' candles. Last close: ' + candles[candles.length - 1][4]);
  const cacheRows = db.prepare('SELECT COUNT(*) as n FROM candles_cache').get();
  log('4', 'candles_cache rows: ' + cacheRows.n);

  if (process.env.BYBIT_TESTNET_API_KEY && process.env.BYBIT_TESTNET_API_SECRET) {
    // Ensure a user exists
    let user = db.prepare('SELECT id FROM users WHERE email = ?').get('smoke@local');
    if (!user) {
      db.prepare(`
        INSERT INTO users (email, password_hash, referral_code, is_active)
        VALUES ('smoke@local', 'x', 'SMOKE0001', 1)
      `).run();
      user = db.prepare('SELECT id FROM users WHERE email = ?').get('smoke@local');
    }

    log('5', 'Adding Bybit testnet key...');
    const key = await exchangeService.addKey(user.id, {
      exchange: 'bybit',
      apiKey: process.env.BYBIT_TESTNET_API_KEY,
      apiSecret: process.env.BYBIT_TESTNET_API_SECRET,
      testnet: true,
      label: 'smoke',
    });
    log('5', 'Key added id=' + key.id + ' masked=' + key.apiKeyMasked);

    log('5', 'Verifying key...');
    const verify = await exchangeService.verifyKey(key.id, user.id);
    log('5', 'Verified=' + verify.verified);

    log('5', 'Fetching balance...');
    const bal = await exchangeService.getBalance(key.id, user.id);
    log('5', 'Total USDT: ' + (bal.total.USDT || 0));

    log('5', 'Cleaning up (delete key)...');
    exchangeService.deleteKey(key.id, user.id);
    log('5', 'Done');
  } else {
    log('5', 'BYBIT_TESTNET_API_KEY not set — skipping key-level tests');
  }

  console.log('\n✅ Smoke test complete.');
  db.close();
})().catch((err) => {
  console.error('❌ Smoke failed:', err);
  process.exit(1);
});
