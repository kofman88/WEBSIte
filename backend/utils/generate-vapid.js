#!/usr/bin/env node
/**
 * Generate VAPID keypair for Web Push.
 *
 *   cd backend && node utils/generate-vapid.js
 *
 * Add the printed keys to your .env:
 *
 *   WEB_PUSH_PUBLIC_KEY=...
 *   WEB_PUSH_PRIVATE_KEY=...
 *   WEB_PUSH_SUBJECT=mailto:security@chmup.top
 *
 * Restart Passenger (touch tmp/restart.txt) and push will start
 * working. Browsers that already subscribed with a different public
 * key must re-subscribe.
 */

let webpush;
try { webpush = require('web-push'); }
catch (e) { console.error('Install web-push first: npm install web-push'); process.exit(1); }

const keys = webpush.generateVAPIDKeys();
console.log('WEB_PUSH_PUBLIC_KEY=' + keys.publicKey);
console.log('WEB_PUSH_PRIVATE_KEY=' + keys.privateKey);
console.log('WEB_PUSH_SUBJECT=mailto:security@chmup.top  # or any URL you own');
