'use strict';
/**
 * load.js — golden fixture loader.
 *
 * Reads the candle fixtures and the expected files produced by the bot's own
 * Python code (see FIXTURES.md / make_golden.py), verifies the sha256 digests
 * recorded in summary.json (so a silently edited fixture fails loudly), and
 * builds the Frame objects once per symbol (cached) exactly like
 * make_golden.load_df: float64 columns, open_time ms index, last row = last
 * closed bar.
 *
 * expected/smc.json and expected/smc_analysis.json are stored gzipped
 * (≈19 MB / 12 MB raw); the digest is checked on the gunzipped bytes.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Frame, TF_MS } = require('../../strategies/common/frame');

const GOLDEN_DIR = __dirname;
const CANDLES_DIR = path.join(GOLDEN_DIR, 'candles');
const EXPECTED_DIR = path.join(GOLDEN_DIR, 'expected');

/** Sweep constants of the generator (make_golden.py). */
const SWEEP = Object.freeze({
  tf: '1h',
  tfMs: TF_MS['1h'],
  warmupIndex: 200,
  windows: { levelsHtf: 300, smcHtf: 300, smcLtf: 300, volumeHtf: 300 },
});

const STRATEGIES = Object.freeze(['levels', 'smc', 'volume']);
const VARIANTS = Object.freeze(['default', 'conservative', 'active']);

let summaryCache = null;
function loadSummary() {
  if (!summaryCache) summaryCache = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, 'summary.json'), 'utf8'));
  return summaryCache;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Raw bytes of an expected file (gunzipped when only the .gz exists). */
function readExpectedBytes(name) {
  const plain = path.join(EXPECTED_DIR, `${name}.json`);
  const gz = path.join(EXPECTED_DIR, `${name}.json.gz`);
  if (fs.existsSync(plain)) return fs.readFileSync(plain);
  if (fs.existsSync(gz)) return zlib.gunzipSync(fs.readFileSync(gz));
  throw new Error(`golden: expected file missing: ${plain}[.gz]`);
}

const expectedCache = new Map();
/**
 * Parsed expected file ('levels' | 'smc' | 'volume' | 'smc_analysis'), sha256
 * asserted against summary.json. Cached for the process lifetime.
 */
function loadExpected(name) {
  if (expectedCache.has(name)) return expectedCache.get(name);
  const bytes = readExpectedBytes(name);
  const summary = loadSummary();
  const want = summary.sha256[`expected/${name}.json`];
  if (!want) throw new Error(`golden: summary.json has no sha256 for expected/${name}.json`);
  const got = sha256(bytes);
  if (got !== want) throw new Error(`golden: sha256 mismatch for expected/${name}.json: ${got} != ${want}`);
  const doc = JSON.parse(bytes.toString('utf8'));
  expectedCache.set(name, doc);
  return doc;
}

let indexCache = null;
/** candles/index.json (fixture metadata: regime, seed, legs …). */
function loadCandleIndex() {
  if (!indexCache) indexCache = JSON.parse(fs.readFileSync(path.join(CANDLES_DIR, 'index.json'), 'utf8'));
  return indexCache;
}

/** Symbols in generator order. */
function listSymbols() {
  return loadCandleIndex().fixtures.map((f) => f.symbol);
}

const frameCache = new Map();
/** Frame of one candle fixture file (cached). */
function loadFrame(symbol, tf) {
  const key = `${symbol}_${tf}`;
  if (frameCache.has(key)) return frameCache.get(key);
  const file = path.join(CANDLES_DIR, `${key}.json`);
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (fx.symbol !== symbol || fx.tf !== tf) throw new Error(`golden: fixture header mismatch in ${file}`);
  const frame = Frame.fromFixture(fx);
  frameCache.set(key, frame);
  return frame;
}

/**
 * All frames a fixture sweep needs, like make_golden.run_fixture:
 * {15m, 1h, 4h, 1d, btc_1h, eth_1h}.
 */
function loadFrames(symbol) {
  return {
    '15m': loadFrame(symbol, '15m'),
    '1h': loadFrame(symbol, '1h'),
    '4h': loadFrame(symbol, '4h'),
    '1d': loadFrame(symbol, '1d'),
    btc_1h: loadFrame('BTC-USDT-SWAP', '1h'),
    eth_1h: loadFrame('ETH-USDT-SWAP', '1h'),
  };
}

/** Sweep indices of the generator (_sweep_indices): warmup..n-1 every `step`, last bar always included. */
function sweepIndices(n, step = 1) {
  const idx = [];
  for (let i = SWEEP.warmupIndex; i < n; i += step) idx.push(i);
  if (idx.length && idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return idx;
}

/**
 * The per-bar inputs of every strategy for sweep index i, built exactly as the
 * generator does (prefix of the 1h series, aux frames = bars closed at
 * open_time[i] + 1h, last W bars). Frames are zero-copy views.
 */
function barInputs(frames, i) {
  const df1h = frames['1h'];
  const closeMs = df1h.t[i] + SWEEP.tfMs;
  const df = df1h.prefix(i);
  return {
    i,
    closeMs,
    openTimeMs: df1h.t[i],
    df,
    dfBtc: frames.btc_1h.prefix(i),
    dfEth: frames.eth_1h.prefix(i),
    dfHtf1d: frames['1d'].closedPrefix('1d', closeMs, SWEEP.windows.levelsHtf),
    dfHtf4h: frames['4h'].closedPrefix('4h', closeMs, SWEEP.windows.smcHtf),
    dfLtf15m: frames['15m'].closedPrefix('15m', closeMs, SWEEP.windows.smcLtf),
  };
}

/** pandas str(Timestamp) of a UTC ms value: "2025-12-23 16:00:00". */
function tsString(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Verify every candle fixture parses and the expected digests match (used by the self-check test). */
function verifyAll() {
  const summary = loadSummary();
  const report = { expected: {}, candles: 0 };
  for (const name of ['levels', 'volume', 'smc_analysis', 'smc']) {
    loadExpected(name);
    report.expected[name] = summary.sha256[`expected/${name}.json`];
  }
  for (const sym of listSymbols()) for (const tf of ['15m', '1h', '4h', '1d']) { loadFrame(sym, tf); report.candles++; }
  return report;
}

module.exports = {
  GOLDEN_DIR, CANDLES_DIR, EXPECTED_DIR, SWEEP, STRATEGIES, VARIANTS,
  loadSummary, loadExpected, loadCandleIndex, listSymbols, loadFrame, loadFrames,
  sweepIndices, barInputs, tsString, verifyAll, sha256, readExpectedBytes,
};
