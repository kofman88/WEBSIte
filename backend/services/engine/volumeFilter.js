/**
 * volumeFilter — the bot's coin-universe volume filters, one-to-one:
 *
 *   applyVolFilter(coins, users, volBySym, getUserMinVol, {capCount, floorUsdt, strategyTag})
 *       volume_filter.apply_vol_filter (SMC scanner / shared helper): the softest
 *       setting of the group wins — any "off" → floor + cap only; max_coins_count =
 *       max over users (then ≤ cap_count); min USDT = min of the positive per-user
 *       minimums (1 000 000 when none), raised to floor_usdt; mode "both" when any
 *       user picked both or count+usdt are mixed, else count / usdt.
 *
 *   midScannerVolFilter(coins, users, volBySym)
 *       scanner_mid.MidScanner._apply_vol_filter (LEVELS): the older variant — "off"
 *       returns the coins untouched (no floor / cap), min USDT = min of
 *       `min_volume_usdt or 1_000_000`, "usdt" keeps the original order and falls back
 *       to all coins when nothing passes, max_coins_count read without int().
 *
 * Sorting is Python's stable `sorted(..., reverse=True)` (ties keep their order).
 */

'use strict';

const { pyFloat, pyInt } = require('./pycoerce');
const { pyTruthy } = require('../../strategies/common/pyval');
const { fmtFixed } = require('../../strategies/common/pyfmt');
const { log: defaultLog } = require('../marketData/mdLog');

const or = (v, d) => (pyTruthy(v) ? v : d);
const get = (u, k, d) => (u && Object.prototype.hasOwnProperty.call(u, k) ? u[k] : d);

/** Python `max(iterable)` over numbers (first max wins). */
function pyMaxOf(xs) {
  let m = xs[0];
  for (let i = 1; i < xs.length; i++) if (xs[i] > m) m = xs[i];
  return m;
}
function pyMinOf(xs) {
  let m = xs[0];
  for (let i = 1; i < xs.length; i++) if (xs[i] < m) m = xs[i];
  return m;
}

/** sorted(coins, key=vol, reverse=True): stable, descending. */
function sortByVolDesc(coins, vol) {
  return coins.map((c, i) => [c, vol(c), i]).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[2] - b[2])).map((x) => x[0]);
}

function applyVolFilter(coins, users, volBySym, getUserMinVol, { capCount = 200, floorUsdt = 0.0, strategyTag = '', log = defaultLog } = {}) {
  if (!coins || !coins.length) return coins;
  const usersList = users ? Array.from(users) : [];
  const vb = volBySym || {};
  const vol = (c) => pyFloat(or(Object.prototype.hasOwnProperty.call(vb, c) ? vb[c] : 0, 0));

  if (!usersList.length) {
    if (floorUsdt > 0) return coins.filter((c) => vol(c) >= floorUsdt);
    return capCount ? coins.slice(0, capCount) : coins;
  }

  const modes = usersList.map((u) => get(u, 'vol_filter_mode', 'usdt'));

  if (modes.includes('off')) {
    const filtered = floorUsdt > 0 ? coins.filter((c) => vol(c) >= floorUsdt) : coins.slice();
    const result = capCount && filtered.length > capCount ? filtered.slice(0, capCount) : filtered;
    log.debug(`${strategyTag || ''} vol_filter OFF: ${result.length}/${coins.length} coins (floor=${fmtFixed(floorUsdt, 0)}, cap=${capCount})`);
    return result;
  }

  let maxCount = pyMaxOf(usersList.map((u) => pyInt(or(get(u, 'max_coins_count', 50), 50))));
  maxCount = capCount ? Math.min(maxCount, capCount) : maxCount;

  const minUsdtValues = [];
  for (const u of usersList) {
    try {
      const v = pyFloat(or(getUserMinVol(u), 0));
      if (v > 0) minUsdtValues.push(v);
    } catch (_e) {
      log.warning('volume_filter._vol() unhandled exception');
    }
  }
  let minUsdt = minUsdtValues.length ? pyMinOf(minUsdtValues) : 1_000_000.0;
  minUsdt = Math.max(minUsdt, floorUsdt);

  const hasBoth = modes.includes('both');
  const hasCount = modes.includes('count');
  const hasUsdt = modes.includes('usdt');
  let final;
  if (hasBoth || (hasCount && hasUsdt)) final = 'both';
  else if (hasCount) final = 'count';
  else final = 'usdt';

  const coinsSorted = sortByVolDesc(coins, vol);

  if (final === 'count' || final === 'both') {
    const topN = coinsSorted.slice(0, maxCount);
    if (final === 'count') {
      log.debug(`${strategyTag || ''} vol_filter COUNT: ${topN.length}/${coins.length} coins (top-${maxCount})`);
      return topN;
    }
    const result = topN.filter((c) => vol(c) >= minUsdt);
    log.debug(`${strategyTag || ''} vol_filter BOTH: ${result.length}/${coins.length} coins (top-${maxCount} ∩ ≥$${fmtFixed(minUsdt, 0)})`);
    return result;
  }

  let result = coinsSorted.filter((c) => vol(c) >= minUsdt);
  if (capCount && result.length > capCount) result = result.slice(0, capCount);
  log.debug(`${strategyTag || ''} vol_filter USDT: ${result.length}/${coins.length} coins (≥$${fmtFixed(minUsdt, 0)})`);
  return result;
}

/** scanner_mid.MidScanner._apply_vol_filter(coins, all_jobs) over the jobs' users. */
function midScannerVolFilter(coins, users, volBySym) {
  if (!coins || !coins.length || !users || !users.length) return coins;
  const modes = users.map((u) => get(u, 'vol_filter_mode', 'usdt'));
  if (modes.includes('off')) return coins;
  const maxCount = pyMaxOf(users.map((u) => get(u, 'max_coins_count', 50)));
  const minUsdt = pyMinOf(users.map((u) => pyFloat(or(get(u, 'min_volume_usdt', 1_000_000), 1_000_000))));
  let finalMode;
  if (modes.includes('both')) finalMode = 'both';
  else if (modes.includes('count') && modes.includes('usdt')) finalMode = 'both';
  else if (modes.includes('count')) finalMode = 'count';
  else finalMode = 'usdt';
  const vb = volBySym || {};
  const vol = (c) => pyFloat(Object.prototype.hasOwnProperty.call(vb, c) ? vb[c] : 0);
  if (finalMode === 'count' || finalMode === 'both') {
    const topN = sortByVolDesc(coins, vol).slice(0, maxCount);
    if (finalMode === 'count') return topN;
    return topN.filter((c) => vol(c) >= minUsdt);
  }
  const filtered = coins.filter((c) => vol(c) >= minUsdt);
  return filtered.length ? filtered : coins;
}

module.exports = { applyVolFilter, midScannerVolFilter, sortByVolDesc };
