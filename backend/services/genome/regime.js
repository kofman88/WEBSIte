'use strict';
/**
 * regime.js — the `market_regime.get_cached_regime()` the genome reads (drift threshold,
 * paper-validation PF gate and age window). The cached BTC regime is live state owned by the
 * scanner (engine worker, M9); it installs a provider with `setRegimeProvider(fn)`. Until then
 * the regime is null → every lookup falls back to the "unknown" defaults, exactly like a bot
 * process whose regime cache is still empty.
 */

let _provider = () => null;

function setRegimeProvider(fn) {
  _provider = typeof fn === 'function' ? fn : () => null;
}

function getCachedRegime() {
  try {
    const r = _provider();
    return r === undefined ? null : r;
  } catch (_e) {
    return null;
  }
}

module.exports = { setRegimeProvider, getCachedRegime };
