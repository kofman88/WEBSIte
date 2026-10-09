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
const { redact, redactDeep } = require('./redact');

// Body / query / extra fields whose value is a secret or PII, wherever they sit in an event.
const REDACT_KEYS = new Set([
  'password', 'password2', 'currentPassword', 'newPassword',
  'apiKey', 'apiSecret', 'exchangeSecret', 'exchangePassphrase',
  'token', 'refreshToken', 'accessToken', 'pendingToken', 'handoffCode',
  'jwt', 'secret', 'tvSecret', 'privateKey',
  'totpSecret', 'otpauth', 'code', 'recoveryCode', 'recoveryCodes',
  'email', 'phone', // PII
]);
function scrubKeys(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 8) return;
  for (const k of Object.keys(o)) {
    if (REDACT_KEYS.has(k)) { o[k] = '[REDACTED]'; continue; }
    if (typeof o[k] === 'object') scrubKeys(o[k], depth + 1);
  }
}
// URLs (an e-mail link's token, the Telegram bot token in a Bot API path, a hand-off code …) out of
// a breadcrumb: outgoing-request breadcrumbs carry the full URL in data.url.
function scrubBreadcrumb(b) {
  if (!b || typeof b !== 'object') return b;
  if (typeof b.message === 'string') b.message = redact(b.message);
  if (b.data && typeof b.data === 'object') b.data = redactDeep(b.data);
  return b;
}
/** The event Sentry is about to send, with secrets out of headers, bodies, URLs, breadcrumbs, spans. */
function scrubEvent(event) {
  if (!event || typeof event !== 'object') return event;
  if (event.request) {
    const h = event.request.headers;
    if (h) {
      for (const k of Object.keys(h)) {
        if (/^(authorization|cookie|x-forwarded-for)$/i.test(k)) delete h[k];
        else if (/^referer$/i.test(k)) h[k] = redact(h[k]);
      }
    }
    delete event.request.cookies;
    if (typeof event.request.url === 'string') event.request.url = redact(event.request.url);
    if (typeof event.request.query_string === 'string') event.request.query_string = redact('?' + event.request.query_string).slice(1);
    scrubKeys(event.request.data);
    scrubKeys(event.request.query_string);
    scrubKeys(event.request.env);
  }
  if (typeof event.transaction === 'string') event.transaction = redact(event.transaction);
  if (typeof event.message === 'string') event.message = redact(event.message);
  if (event.extra) { scrubKeys(event.extra); event.extra = redactDeep(event.extra); }
  if (event.contexts) event.contexts = redactDeep(event.contexts);
  if (Array.isArray(event.breadcrumbs)) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  else if (event.breadcrumbs && Array.isArray(event.breadcrumbs.values)) event.breadcrumbs.values = event.breadcrumbs.values.map(scrubBreadcrumb);
  if (Array.isArray(event.spans)) {
    for (const sp of event.spans) {
      if (typeof sp.description === 'string') sp.description = redact(sp.description);
      if (sp.data) sp.data = redactDeep(sp.data);
    }
  }
  if (event.exception && Array.isArray(event.exception.values)) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === 'string') ex.value = redact(ex.value);
      // Redact file paths in stack frames (leak less about server layout)
      if (!ex.stacktrace || !ex.stacktrace.frames) continue;
      for (const f of ex.stacktrace.frames) {
        if (f.filename) f.filename = f.filename.replace(/^\/home\/[^/]+/, '~');
        if (f.abs_path) f.abs_path = f.abs_path.replace(/^\/home\/[^/]+/, '~');
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
      // Scrub sensitive headers + body + query fields + every URL. Defence-in-depth: we still never
      // pass plaintext secrets into log.info / error with these keys, but this makes PII and secret
      // leakage through stack traces, captured request state, breadcrumbs and spans much harder.
      beforeSend: scrubEvent,
      beforeSendTransaction: scrubEvent,
      beforeBreadcrumb: scrubBreadcrumb,
    });
    enabled = true;
    logger.info('Sentry error tracking enabled');
  } catch (err) {
    logger.error('Sentry init failed', { err: err.message });
  }
})();

function captureException(err, context = {}) {
  if (!enabled) return;
  try { Sentry.captureException(err, { extra: redactDeep(context) }); } catch (_e) {}
}

function captureMessage(msg, level = 'info', context = {}) {
  if (!enabled) return;
  try { Sentry.captureMessage(redact(msg), { level, extra: redactDeep(context) }); } catch (_e) {}
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

module.exports = { captureException, captureMessage, setUser, requestHandler, errorHandler, isEnabled: () => enabled, scrubEvent, scrubBreadcrumb };
