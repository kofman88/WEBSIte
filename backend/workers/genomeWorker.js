'use strict';
/**
 * genomeWorker.js — worker_threads entry of the Strategy Genome (PLAN §2.2 / M16).
 *
 * Runs ONE generation per message, off the main thread, at low priority (os.setPriority 19):
 *
 *   in : { type: 'evolve', id, strategy, tf, mode: 'manual' | 'cycle',
 *          coins?: [coin], candles?: { coin: {t, o, h, l, c, v} }, cpuShare?, seed?, timeoutS? }
 *   out: { type: 'progress', id, strategy, tf, generation, done, total, best_fit, best_wr, zero_trades }
 *        { type: 'result', id, result: {ok: true, …evolve_generation result} | {ok: false, error} }
 *   in : { type: 'regime', regime } → market_regime.get_cached_regime() of this thread (the
 *          engine's cached BTC regime; the evolve message carries the first value) — accepted
 *          while a generation runs
 *   in : { type: 'shutdown' } → closes the port.
 *
 * CPU budget (the bot's [GENOME-CPU-BUDGET]): after every coin backtest the evaluation sleeps
 * elapsed × (1/share − 1), share = GENOME_CPU_SHARE (default 0.15 on a 1-CPU host, else 0.35);
 * the per-genome timeout is TF timeout / share, the whole evaluation aborts at 1800 s
 * ("FULL generation eval TIMEOUT"), a manual run at 700 s.
 *
 * Without `candles` the worker loads the basket itself (coinBasket + candleStore on its own
 * SQLite connection). It is NOT started automatically — services/genome/runner.js spawns it on
 * demand (and the scheduler will, for the 6 h cycle).
 */

const os = require('os');
const { parentPort, isMainThread } = require('worker_threads');
const { performance } = require('perf_hooks');
const { pyUpper } = require('../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

function lowerPriority() {
  try { os.setPriority(19); } catch (_e) { /* not permitted → ignore (bot: os.nice(10) best effort) */ }
}

function framesFrom(candles) {
  const { Frame } = require('../strategies/common/frame');
  const out = new Map();
  for (const [coin, cols] of Object.entries(candles || {})) out.set(coin, Frame.fromColumns(cols));
  return out;
}

/** Handle one message; `post` sends a message back (parentPort.postMessage in the worker). */
/** The cached regime the genome reads in this thread (services/genome/regime.js provider). */
const regimeState = { value: null };
function setRegime(value) {
  regimeState.value = value === undefined ? null : value;
  require('../services/genome/regime').setRegimeProvider(() => regimeState.value);
}

async function handleMessage(msg, post) {
  if (msg && msg.type === 'regime') {
    setRegime(msg.regime);
    return null;
  }
  if (!msg || msg.type !== 'evolve') return null;
  if (Object.prototype.hasOwnProperty.call(msg, 'regime')) setRegime(msg.regime);
  const C = require('../services/genome/config');
  const evolve = require('../services/genome/evolve');
  const { DeadlineError } = require('../services/genome/evaluate');
  const { createRng } = require('../services/genome/rng');
  const id = msg.id;
  const strategy = pyUpper(String(msg.strategy || 'LEVELS'));
  const tf = msg.tf || C.getDefaultTf(strategy);
  const mono = () => performance.now();
  const deps = {
    cpuShare: msg.cpuShare || C.genomeCpuShare(),
    onProgress: (p) => post({ type: 'progress', id, ...p }),
  };
  if (msg.seed !== undefined && msg.seed !== null) deps.rng = createRng(msg.seed);
  if (msg.candles) {
    deps.preloaded = framesFrom(msg.candles);
    const coins = msg.coins && msg.coins.length ? msg.coins : Array.from(deps.preloaded.keys());
    deps.getCoins = async () => coins.slice();
  } else if (msg.coins && msg.coins.length) {
    deps.getCoins = async () => msg.coins.slice();
  }
  if (msg.mode === 'manual') {
    deps.deadlines = [{ at: mono() + (msg.timeoutS || C.MANUAL_EVOLUTION_TIMEOUT_S) * 1000, kind: 'manual' }];
  } else if (msg.timeoutS) {
    deps.generationTimeoutS = msg.timeoutS;
  }
  let result;
  try {
    const r = await evolve.evolveGeneration(strategy, tf, deps);
    result = { ok: true, ...r };
  } catch (e) {
    if (e instanceof DeadlineError && e.kind === 'manual') result = { ok: false, error: 'Таймаут 10 мин — OKX недоступен или данных нет' };
    else result = { ok: false, error: String(e && e.message !== undefined ? e.message : e) };
  }
  post({ type: 'result', id, result });
  return result;
}

if (!isMainThread && parentPort) {
  lowerPriority();
  let busy = false;
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'shutdown') {
      parentPort.close();
      return;
    }
    if (msg && msg.type === 'regime') {
      handleMessage(msg, () => {});
      return;
    }
    if (busy) {
      parentPort.postMessage({ type: 'result', id: msg && msg.id, result: { ok: false, error: 'Эволюция уже идёт, подожди 1-3 мин' } });
      return;
    }
    busy = true;
    handleMessage(msg, (m) => parentPort.postMessage(m))
      .catch((e) => parentPort.postMessage({ type: 'result', id: msg && msg.id, result: { ok: false, error: String(e && e.message) } }))
      .finally(() => { busy = false; });
  });
}

module.exports = { handleMessage, framesFrom, lowerPriority, setRegime, regimeState };
