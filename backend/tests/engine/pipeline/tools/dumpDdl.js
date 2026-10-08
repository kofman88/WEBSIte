'use strict';
/**
 * dumpDdl.js — the site's signal_trades / trade_events DDL (models/engineSchema.js, the
 * bot's `trades` table verbatim) renamed back to the bot's table names, so gen_vectors.py
 * can run the bot's db/trades.py / db/signal_progress.py / db/trade_events.py functions
 * on exactly the columns the site has.
 *
 *   node tests/engine/pipeline/tools/dumpDdl.js → tests/engine/pipeline/fixtures/trades_ddl.sql
 */

const fs = require('fs');
const path = require('path');
const { signalTradesDDL, TRADE_EVENTS_DDL, ENGINE_KV_DDL } = require('../../../../models/engineSchema');

const ddl = signalTradesDDL()
  .replace(/,\s*FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/, '')
  .replace(/signal_trades/g, 'trades')
  .replace(/idx_trades_/g, 'idx_bot_trades_');

const out = `${ddl}\n${TRADE_EVENTS_DDL}\n${ENGINE_KV_DDL.replace(/engine_kv/g, 'kv')}\n`;
fs.writeFileSync(path.join(__dirname, '..', 'fixtures', 'trades_ddl.sql'), out);
process.stdout.write('trades_ddl.sql written\n');
