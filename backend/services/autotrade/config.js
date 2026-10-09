'use strict';
/**
 * config.js — the bot config.py values execute_auto_trade reads, parsed from the environment
 * exactly like the bot (Config class attributes, evaluated once at import).
 *
 *   SMC_HOUR_FILTER_ENABLED  env "1" (default) after strip()
 *   SMC_HOUR_FILTER_MODE     "shadow" | "enforce" (default) | "off"; unknown → "off"
 *   BAD_HOURS_UTC            {SMC: [4, 18, 19, 20, 22]}; SMC_BAD_HOURS_UTC="h,h,…" overrides when
 *                            every token is a digit string 0..23 (any bad token → default kept)
 *   DAILY_MAX_LOSS_R         float(env, default "0.0")
 */

const { pyFloat } = require('../exchanges/pyCompat');
const { pyLower, pyStrip, pyIsdigit } = require('../../strategies/common/pyUnicode');

const DEFAULT_SMC_BAD_HOURS = Object.freeze([4, 18, 19, 20, 22]);

function readConfig(env = process.env) {
  const get = (k, d) => (env[k] === undefined ? d : String(env[k]));
  const smcEnabled = pyStrip(get('SMC_HOUR_FILTER_ENABLED', '1')) === '1';
  let mode = pyLower(pyStrip(get('SMC_HOUR_FILTER_MODE', 'enforce')));
  if (!['shadow', 'enforce', 'off'].includes(mode)) mode = 'off';
  let smcBad = DEFAULT_SMC_BAD_HOURS.slice();
  const raw = get('SMC_BAD_HOURS_UTC', '');
  if (pyStrip(raw)) {
    const parsed = [];
    let ok = true;
    for (const tok of raw.split(',')) {
      const t = pyStrip(tok);
      const n = /^[0-9]+$/.test(t) ? Number(t) : NaN;
      if (pyIsdigit(t) && Number.isInteger(n) && n >= 0 && n <= 23) parsed.push(n);
      else { ok = false; break; }
    }
    if (ok) smcBad = parsed;
  }
  let dailyMax = 0.0;
  try {
    dailyMax = pyFloat(get('DAILY_MAX_LOSS_R', '0.0'));
  } catch (_e) {
    dailyMax = 0.0; // the bot would fail to import; the site keeps the circuit breaker off
  }
  return {
    SMC_HOUR_FILTER_ENABLED: smcEnabled,
    SMC_HOUR_FILTER_MODE: mode,
    BAD_HOURS_UTC: { SMC: smcBad },
    DAILY_MAX_LOSS_R: dailyMax,
  };
}

module.exports = { readConfig, DEFAULT_SMC_BAD_HOURS };
