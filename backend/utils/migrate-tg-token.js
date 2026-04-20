#!/usr/bin/env node
/**
 * One-shot helper: move TELEGRAM_BOT_TOKEN from .env into encrypted
 * system_kv storage, so operators can then remove the plaintext token
 * from .env.
 *
 * Usage (from backend/):
 *   node utils/migrate-tg-token.js              # use $TELEGRAM_BOT_TOKEN
 *   node utils/migrate-tg-token.js <token>      # pass token explicitly
 *   node utils/migrate-tg-token.js --clear      # remove encrypted copy
 *
 * After migration:
 *   1. Edit .env, remove the TELEGRAM_BOT_TOKEN line.
 *   2. Restart Passenger (touch tmp/restart.txt).
 *   3. Verify: curl /api/health/deep, /api/telegram/status.
 *   The service will load the decrypted token from system_kv.
 */

require('dotenv').config();
const tg = require('../services/telegramService');
const db = require('../models/database');

const arg = process.argv[2];

function main() {
  if (arg === '--clear') {
    const info = db.prepare("DELETE FROM system_kv WHERE key = 'tg_bot_token_enc'").run();
    console.log(info.changes > 0 ? 'Encrypted TG token removed from system_kv.' : 'No encrypted TG token to remove.');
    return;
  }
  const token = arg || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('No token provided: pass as argument or set TELEGRAM_BOT_TOKEN in .env');
    process.exit(1);
  }
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    console.error('Token does not look like a Telegram bot token (expected "<botId>:<secret>")');
    process.exit(1);
  }
  tg.setBotToken(token);
  console.log('OK — encrypted TG token stored in system_kv.');
  console.log('Now remove TELEGRAM_BOT_TOKEN from .env and restart Passenger.');
}

main();
