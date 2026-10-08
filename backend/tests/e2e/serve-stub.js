#!/usr/bin/env node
'use strict';
/**
 * Serve frontend/ with the contract stub of /api/app/* and /api/auth/* for
 * manual QA and the Playwright smoke (backend/tests/e2e/app_smoke.py).
 *
 *   node backend/tests/e2e/serve-stub.js [port]      → http://127.0.0.1:<port>/app/
 *   credentials: demo@chm.local / pro@chm.local / 2fa@chm.local (password demo1234)
 */
const path = require('path');
const { createStubServer } = require('../../utils/app-stub');

const port = parseInt(process.argv[2], 10) || 3999;
const app = createStubServer({ staticDir: path.join(__dirname, '..', '..', '..', 'frontend') });
app.listen(port, '127.0.0.1', () => {
  process.stdout.write(`stub listening on http://127.0.0.1:${port}/app/\n`);
});
