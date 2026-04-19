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

let Sentry = null;
let enabled = false;

(function init() {
  if (!config.sentryDsn) return;
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    Sentry = require('@sentry/node');
  } catch (_e) {
    logger.warn('SENTRY_DSN is set but @sentry/node is not installed — install it to enable error tracking');
    return;
  }
  try {
    Sentry.init({
      dsn: config.sentryDsn,
      environment: config.isProd ? 'production' : (process.env.NODE_ENV || 'development'),
      release: '3.0.0',
      tracesSampleRate: 0.05,
      beforeSend(event) {
        // Scrub sensitive headers + body fields defensively.
        if (event.request && event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
        if (event.request && event.request.data) {
          const d = event.request.data;
          if (d && typeof d === 'object') {
            for (const k of ['password', 'password2', 'apiKey', 'apiSecret', 'token', 'refreshToken']) {
              if (k in d) d[k] = '[REDACTED]';
            }
          }
        }
        return event;
      },
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
  try { Sentry.setUser(user ? { id: user.id, email: user.email } : null); } catch (_e) {}
}

function requestHandler() {
  if (!enabled) return (_req, _res, next) => next();
  return Sentry.Handlers ? Sentry.Handlers.requestHandler() : ((_req, _res, next) => next());
}

function errorHandler() {
  if (!enabled) return (err, _req, _res, next) => next(err);
  return Sentry.Handlers ? Sentry.Handlers.errorHandler() : ((err, _req, _res, next) => next(err));
}

module.exports = { captureException, captureMessage, setUser, requestHandler, errorHandler, isEnabled: () => enabled };
