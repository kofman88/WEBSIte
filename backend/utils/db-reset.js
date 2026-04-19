#!/usr/bin/env node
/**
 * Dev-only: DROP and recreate the entire database.
 * USE WITH CARE — wipes everything.
 *
 * Usage: npm run db:reset
 *   Requires: NODE_ENV != production AND env DB_RESET_CONFIRM=yes
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

if (config.isProd) {
  console.error('❌ Refusing to run db:reset in production.');
  process.exit(1);
}

if (process.env.DB_RESET_CONFIRM !== 'yes') {
  console.error('❌ Refusing to run. Set DB_RESET_CONFIRM=yes to confirm.');
  console.error('   Example: DB_RESET_CONFIRM=yes npm run db:reset');
  process.exit(1);
}

const dbPath = config.databasePath;
[dbPath, dbPath + '-wal', dbPath + '-shm'].forEach((p) => {
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log('🗑  Removed', path.basename(p));
  }
});

// Re-init
require('../models/database');
console.log('✅ Fresh database created at', dbPath);
