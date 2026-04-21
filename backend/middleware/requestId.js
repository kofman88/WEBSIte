/**
 * Request correlation IDs — assigns a unique id to each request, attaches
 * it as req.id / X-Request-ID response header, and bumps the logger with
 * a child context so every log line the handler produces can be traced
 * back to a single request.
 *
 * Honors inbound X-Request-ID if the client sends one (useful when
 * multiple services chain calls).
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

// 16 hex chars (~64 bits) — short enough for logs, unique enough at scale
function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function requestIdMiddleware(req, res, next) {
  const inbound = req.header('X-Request-ID') || req.header('X-Correlation-ID');
  const id = (inbound && /^[a-zA-Z0-9-_]{4,64}$/.test(inbound)) ? inbound : newId();
  req.id = id;
  req.log = logger.child({ reqId: id });
  res.setHeader('X-Request-ID', id);
  next();
}

module.exports = { requestIdMiddleware, newId };
