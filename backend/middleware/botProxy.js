/**
 * Reverse proxy for the bot's Mini App — the site serves the app at /app.
 *
 *   /app            → 302 /app/
 *   /app/…          → http://127.0.0.1:8080/miniapp/…
 *   /miniapp/…      → http://127.0.0.1:8080/miniapp/…   (same origin for cookies)
 *
 * Mounted BEFORE helmet / body parsers so the request body streams through
 * untouched and the bot's own headers (Set-Cookie, Cache-Control, Content-Type)
 * reach the browser unchanged. Only the Mini App prefix is reachable: /admin
 * and /metrics of the bot are never proxied. A `Location: /miniapp/…` from
 * the bot is rewritten back under /app so the user stays on the site path.
 */

const http = require('http');
const https = require('https');
const logger = require('../utils/logger');

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

/** Map a site path to the bot path, or null when the request is not for the app. */
function mapPath(pathname) {
  if (pathname === '/app') return { redirect: '/app/' };
  if (pathname.startsWith('/app/')) return { target: '/miniapp/' + pathname.slice('/app/'.length), prefix: '/app' };
  if (pathname === '/miniapp' || pathname.startsWith('/miniapp/')) return { target: pathname, prefix: '/miniapp' };
  return null;
}

function rewriteLocation(loc, prefix) {
  if (!loc || prefix !== '/app') return loc;
  // absolute or relative /miniapp/… → /app/…
  return String(loc).replace(/^(https?:\/\/[^/]+)?\/miniapp(\/|$)/, '$1/app$2');
}

function createBotProxy({ apiUrl, enabled }) {
  const target = new URL(apiUrl || 'http://127.0.0.1:8080');
  const lib = target.protocol === 'https:' ? https : http;
  return function botProxy(req, res, next) {
    if (!enabled) return next();
    const qIdx = req.url.indexOf('?');
    const pathname = qIdx >= 0 ? req.url.slice(0, qIdx) : req.url;
    const search = qIdx >= 0 ? req.url.slice(qIdx) : '';
    const m = mapPath(pathname);
    if (!m) return next();
    if (m.redirect) { res.statusCode = 302; res.setHeader('Location', m.redirect + search); return res.end(); }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
    headers.host = target.host;
    const ip = req.socket && req.socket.remoteAddress;
    const fwd = req.headers['x-forwarded-for'];
    headers['x-forwarded-for'] = fwd ? fwd + ', ' + ip : ip;
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http');
    headers['x-forwarded-host'] = req.headers.host || '';

    const up = lib.request({
      hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method, path: m.target + search, headers, timeout: 30_000,
    }, (ur) => {
      const out = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
      if (out.location) out.location = rewriteLocation(out.location, m.prefix);
      res.writeHead(ur.statusCode || 502, out);
      ur.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('bot upstream timeout')));
    up.on('error', (err) => {
      logger.warn('bot proxy upstream error', { path: pathname, err: err.message });
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      }
      res.end(JSON.stringify({ ok: false, error: 'unavailable', message: 'Бот временно недоступен — попробуйте через минуту' }));
    });
    req.pipe(up);
  };
}

module.exports = { createBotProxy, mapPath, rewriteLocation };
