/**
 * Simple logger factory for CHM Finance backend.
 * Usage: const log = require('./utils/logger')('ModuleName');
 *        log.info('message');
 */
module.exports = function createLogger(module) {
  const prefix = `[CHM.${module}]`;
  return {
    info:  (...args) => console.log(new Date().toISOString(), prefix, ...args),
    warn:  (...args) => console.warn(new Date().toISOString(), prefix, '⚠️', ...args),
    error: (...args) => console.error(new Date().toISOString(), prefix, '❌', ...args),
    debug: (...args) => {
      if (process.env.DEBUG) console.log(new Date().toISOString(), prefix, '🔍', ...args);
    },
  };
};
