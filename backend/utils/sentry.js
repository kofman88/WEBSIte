/**
 * Sentry wrapper — zero-dep by default.
 *
 * If `@sentry/node` is installed AND `SENTRY_DSN` is configured, initializes
 * Sentry and exposes real `captureException` / `captureMessage` / `setUser`.
 * Otherwise every export is a no-op, so the rest of the app can call
 * `sentry.captureException(err)` safely in any environment.
 *
 * To enable in production:
 *   cd backend && npm install --save @sentry/node
 *   export SENTRY_DSN=https://...@sentry.io/...
 */

const config = require('../config');
const logger = require('./logger');

/**
 * Sentry beforeSend: scrub sensitive headers + body + query fields (also the `extra` context).
 * Defence-in-depth: we still never pass plaintext secrets into log.info / error with these keys,
 * but this makes key / PII leakage through captured request state much harder.
 */
const REDACT_KEYS = new Set([
  'password', 'password2', 'currentPassword', 'newPassword',
  'apiKey', 'apiSecret', 'exchangeSecret', 'exchangePassphrase',
  // the app's exchange-key bodies (bot field names) and the traders' signed requests
  'api_key', 'api_secret', 'passphrase', 'okx_passphrase', 'signature', 'sign',
  'token', 'refreshToken', 'accessToken', 'pendingToken',
  'jwt', 'secret', 'tvSecret', 'privateKey',
  'totpSecret', 'code', 'recoveryCode',
  'email', 'phone', // PII
]);
const REDACT_HEADERS = ['authorization', 'cookie', 'x-forwarded-for', 'x-bapi-api-key', 'x-bapi-sign', 'x-bx-apikey', 'x-mbx-apikey',
  'ok-access-key', 'ok-access-sign', 'ok-access-passphrase'];
function scrub(o, seen = new Set()) {
  if (!o || typeof o !== 'object' || seen.has(o)) return;
  seen.add(o);
  for (const k of Object.keys(o)) {
    if (REDACT_KEYS.has(k)) { o[k] = '[REDACTED]'; continue; }
    if (typeof o[k] === 'object') scrub(o[k], seen);
  }
}
function scrubEvent(event) {
  if (!event || typeof event !== 'object') return event;
  if (event.request) {
    if (event.request.headers) {
      for (const h of Object.keys(event.request.headers)) if (REDACT_HEADERS.includes(h.toLowerCase())) delete event.request.headers[h];
    }
    scrub(event.request.data);
    scrub(event.request.query_string);
    scrub(event.request.env);
  }
  scrub(event.extra);
  scrub(event.contexts);
  // Redact file paths in stack frames (leak less about server layout)
  if (event.exception && event.exception.values) {
    for (const ex of event.exception.values) {
      if (!ex.stacktrace || !ex.stacktrace.frames) continue;
      for (const f of ex.stacktrace.frames) {
        if (f.filename) f.filename = f.filename.replace(/^\/home\/[^/]+/, '~');
        if (f.abs_path) f.abs_path = f.abs_path.replace(/^\/home\/[^/]+/, '~');
        if (f.vars) scrub(f.vars);
      }
    }
  }
  return event;
}

let Sentry = null;
let enabled = false;

(function init() {
  if (!config.sentryDsn) return;
  try {
    // eslint-disable-next-line global-require
    Sentry = require('@sentry/node');
  } catch (_e) {
    logger.warn('SENTRY_DSN is set but @sentry/node is not installed — install it to enable error tracking');
    return;
  }
  try {
    Sentry.init({
      dsn: config.sentryDsn,
      environment: config.isProd ? 'production' : (process.env.NODE_ENV || 'development'),
      release: process.env.BUILD_SHA || process.env.GIT_SHA || require('../package.json').version || '3.0.0',
      // 100% of ERRORS are always captured (sampleRate). Only performance
      // traces are sampled — 10% in prod, 100% in dev.
      sampleRate: 1.0,
      tracesSampleRate: config.isProd ? 0.1 : 1.0,
      beforeSend: scrubEvent,
    });
    enabled = true;
    logger.info('Sentry error tracking enabled');
  } catch (err) {
    logger.error('Sentry init failed', { err: err.message });
  }
})();

function captureException(err, context = {}) {
  if (!enabled) return;
  try { Sentry.captureException(err, { extra: context }); } catch (_e) {}
}

function captureMessage(msg, level = 'info', context = {}) {
  if (!enabled) return;
  try { Sentry.captureMessage(msg, { level, extra: context }); } catch (_e) {}
}

function setUser(user) {
  if (!enabled) return;
  // Only user.id — don't send email / IP to Sentry (PII).
  try { Sentry.setUser(user ? { id: user.id } : null); } catch (_e) {}
}

function requestHandler() {
  if (!enabled) return (_req, _res, next) => next();
  return Sentry.Handlers ? Sentry.Handlers.requestHandler() : ((_req, _res, next) => next());
}

function errorHandler() {
  if (!enabled) return (err, _req, _res, next) => next(err);
  return Sentry.Handlers ? Sentry.Handlers.errorHandler() : ((err, _req, _res, next) => next(err));
}

module.exports = { captureException, captureMessage, setUser, requestHandler, errorHandler, isEnabled: () => enabled, scrubEvent, REDACT_KEYS };
