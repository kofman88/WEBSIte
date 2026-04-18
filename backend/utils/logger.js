/**
 * Winston logger — JSON in prod (for log aggregators), pretty in dev.
 * Daily rotating file `logs/app-YYYY-MM-DD.log` kept for 14 days.
 * Error-level events additionally logged to `logs/error-YYYY-MM-DD.log`.
 *
 * Usage:
 *   const log = require('./utils/logger');
 *   log.info('user signed up', { userId: 42 });
 *   log.error('db query failed', { err: err.message });
 */

const path = require('path');
const fs = require('fs');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const config = require('../config');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
try {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
  // ignore — logger will fall back to stdout only
}

const formats = {
  pretty: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `${timestamp} ${level} ${message}${extra}`;
    })
  ),
  json: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
};

const transports = [];

// Always log to stdout
transports.push(
  new winston.transports.Console({
    format: config.isProd ? formats.json : formats.pretty,
    level: config.logLevel,
  })
);

// In addition, in prod (or when LOG_DIR is writable), log to rotating files
if (config.isProd || fs.existsSync(LOG_DIR)) {
  try {
    transports.push(
      new DailyRotateFile({
        dirname: LOG_DIR,
        filename: 'app-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxFiles: '14d',
        maxSize: '20m',
        format: formats.json,
        level: 'info',
      })
    );
    transports.push(
      new DailyRotateFile({
        dirname: LOG_DIR,
        filename: 'error-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxFiles: '30d',
        maxSize: '20m',
        format: formats.json,
        level: 'error',
      })
    );
  } catch (e) {
    // File transport failed (permissions on cPanel?) — stdout only
  }
}

const logger = winston.createLogger({
  level: config.logLevel,
  transports,
  exitOnError: false,
});

// Convenience methods used throughout the codebase
module.exports = {
  error: (msg, meta) => logger.error(msg, meta),
  warn:  (msg, meta) => logger.warn(msg, meta),
  info:  (msg, meta) => logger.info(msg, meta),
  debug: (msg, meta) => logger.debug(msg, meta),
  child: (bindings) => logger.child(bindings),
  // Expose raw winston instance for advanced cases (streams, etc.)
  _raw: logger,
};
