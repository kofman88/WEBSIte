'use strict';
/**
 * geneSpace.js — genome.GENE_SPACE (LEVELS 17 / SMC 12 / VOLUME 22 genes, declaration order
 * kept: mutate / bayesian_mutate / random_genome iterate it), random_gene_value and the
 * genome (de)serialisation (genome-challenge-profiles.md §1.2–§1.3, §1.5).
 *
 * random_gene_value QUIRK (kept): a float gene draws `round(min + randint(0, n) × step, 4)`
 * with `n = max(1, int((max − min) / step))` — the quotient is truncated, so (1.5 − 0.8)/0.1 =
 * 6.999… → 6 and the nominal max is unreachable for LEVELS vol_mult (1.4), zone_pct (1.1),
 * max_dist_pct (1.9) and VOLUME bounce_vol_mult (1.4).
 */

const { pyRound } = require('../../strategies/common/pyround');
const { pyRepr } = require('../../strategies/common/pyfmt');
const { defaultRng } = require('./rng');

const f = (min, max, step) => Object.freeze({ type: 'float', min, max, step });
const i = (min, max) => Object.freeze({ type: 'int', min, max });
const c = (values) => Object.freeze({ type: 'choice', values: Object.freeze(values) });
const b = () => Object.freeze({ type: 'bool' });

const GENE_SPACE = Object.freeze({
  LEVELS: Object.freeze({
    min_rr: f(1.2, 3.0, 0.1),
    min_quality: i(2, 4),
    vol_mult: f(0.8, 1.5, 0.1),
    vol_len: c([14, 20, 30]),
    rsi_period: c([10, 14, 21]),
    rsi_ob: i(65, 75),
    rsi_os: i(25, 35),
    use_rsi: b(),
    use_volume: b(),
    ema_fast: c([9, 12, 20]),
    ema_slow: c([26, 50, 100]),
    zone_pct: f(0.4, 1.2, 0.1),
    max_dist_pct: f(0.8, 2.0, 0.1),
    tp1_rr: f(1.0, 2.5, 0.1),
    tp2_rr: f(1.5, 3.5, 0.1),
    pivot_strength: c([3, 5, 7, 10]),
    cooldown_bars: c([3, 5, 8, 12]),
  }),
  SMC: Object.freeze({
    min_rr: f(1.5, 2.5, 0.1),
    min_confirmations: i(2, 4),
    sl_buffer_pct: f(0.1, 0.5, 0.05),
    ob_max_age: c([40, 60, 80, 100, 120]),
    fvg_enabled: b(),
    choch_enabled: b(),
    ob_use_breaker: b(),
    sweep_close_req: b(),
    smc_pd_filter: b(),
    smc_retrace_depth: c([0.0, 0.2, 0.3, 0.5]),
    smc_vol_mult: f(1.0, 2.0, 0.1),
    smc_use_volume_filter: b(),
  }),
  VOLUME: Object.freeze({
    ma_type: c(['sma', 'ema']),
    ma_fast: c([5, 8, 9, 10, 12]),
    ma_mid: c([20, 21, 26, 30]),
    ma_slow: c([50, 55, 100]),
    ema_trend: c([150, 200]),
    cross_lookback: c([1, 2, 3]),
    turn_period: c([10, 20]),
    turn_lookback: c([3, 4, 5, 6, 8]),
    turn_slope_bars: c([1, 2, 3]),
    bounce_tol_atr: f(0.1, 0.5, 0.05),
    bounce_vol_mult: f(0.8, 1.5, 0.1),
    vol_mult: f(1.2, 2.5, 0.1),
    vol_len: c([14, 20, 30]),
    climax_mult: f(3.5, 6.0, 0.5),
    extension_atr: f(1.5, 3.5, 0.25),
    rsi_long_max: i(62, 78),
    rsi_short_min: i(22, 38),
    sl_atr_mult: f(1.2, 3.0, 0.1),
    swing_lookback: c([5, 8, 10, 14]),
    tp1_rr: f(1.0, 1.6, 0.1),       // [VOL-TP1-FLOOR] ≥ 1R
    tp2_rr: f(1.5, 3.0, 0.1),
    min_quality: i(2, 4),
  }),
});

/** GENE_SPACE.get(strategy, {}) */
function spaceOf(strategy) {
  return Object.prototype.hasOwnProperty.call(GENE_SPACE, strategy) ? GENE_SPACE[strategy] : {};
}

/** int((max − min) / step) floored at 1 — the truncating step count of random_gene_value. */
function floatSteps(def) {
  const step = def.step === undefined ? 0.1 : def.step;
  return Math.max(1, Math.trunc((def.max - def.min) / step));
}

/** random_gene_value(gene_def, rng) */
function randomGeneValue(def, rng = defaultRng()) {
  const t = def && def.type !== undefined ? def.type : 'float';
  if (t === 'float') {
    const step = def.step === undefined ? 0.1 : def.step;
    const n = floatSteps(def);
    return pyRound(def.min + rng.randint(0, n) * step, 4);
  }
  if (t === 'int') return rng.randint(def.min, def.max);
  if (t === 'choice') return rng.choice(def.values);
  if (t === 'bool') return rng.choice([true, false]);
  return null;
}

/**
 * Keys whose values are Python floats in a genome (json.dumps prints them as `2.0`): every
 * float gene, the float choice gene smc_retrace_depth and the derived VOLUME tp3_rr. No gene
 * name is a float in one strategy and an int in another, so one set serves all three.
 */
const FLOAT_GENE_KEYS = Object.freeze(new Set([
  ...Object.values(GENE_SPACE).flatMap((space) => Object.entries(space)
    .filter(([, d]) => d.type === 'float' || (d.type === 'choice' && d.values.some((v) => typeof v === 'number' && !Number.isInteger(v))))
    .map(([k]) => k)),
  'tp3_rr', 'pullback_tol_pct',
]));

/** json.dumps string escaping with ensure_ascii=True. */
function pyJsonStr(s) {
  let out = '"';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    const code = s.charCodeAt(k);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20 || code > 0x7e) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

/**
 * json.dumps(value, sort_keys=?, separators=?) for genome-shaped data (flat dicts of
 * scalars, nested dicts / lists allowed); `floatKeys` names the keys holding Python floats.
 */
function pyDumps(value, { sortKeys = false, itemSep = ', ', keySep = ': ', floatKeys = FLOAT_GENE_KEYS } = {}) {
  const num = (n, key) => {
    if (Number.isNaN(n)) return 'NaN';
    if (!Number.isFinite(n)) return n > 0 ? 'Infinity' : '-Infinity';
    if ((key !== null && floatKeys && floatKeys.has(key)) || !Number.isInteger(n)) return pyRepr(n);
    return String(n);
  };
  const walk = (v, key) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return num(v, key);
    if (typeof v === 'string') return pyJsonStr(v);
    if (Array.isArray(v)) return '[' + v.map((x) => walk(x, null)).join(itemSep) + ']';
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      if (sortKeys) keys.sort();
      return '{' + keys.map((k) => pyJsonStr(String(k)) + keySep + walk(v[k], k)).join(itemSep) + '}';
    }
    return pyJsonStr(String(v));
  };
  return walk(value, null);
}

/** serialize_genome(genome) = json.dumps(genome, sort_keys=True) */
function serializeGenome(genome) {
  return pyDumps(genome, { sortKeys: true });
}

/** deserialize_genome(s): empty / invalid → {} */
function deserializeGenome(s) {
  if (!s) return {};
  try {
    const v = JSON.parse(String(s));
    return v === null ? {} : v;
  } catch (_e) {
    return {};
  }
}

/** json.dumps(genome, sort_keys=True, separators=(",", ":")) — the eval-cache key body. */
function compactGenomeJson(genome) {
  return pyDumps(genome, { sortKeys: true, itemSep: ',', keySep: ':' });
}

module.exports = {
  GENE_SPACE, spaceOf, floatSteps, randomGeneValue, FLOAT_GENE_KEYS,
  pyJsonStr, pyDumps, serializeGenome, deserializeGenome, compactGenomeJson,
};
