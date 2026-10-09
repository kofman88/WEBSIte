'use strict';
/**
 * gracefulShutdown — bot.py `_request_stop` / `_shutdown_deadline` / the final `_hard_exit(0)`
 * for the site process (server.js).
 *
 * Stop requests come from SIGTERM / SIGINT (standalone, PM2) and — the one that matters on cPanel —
 * from Phusion Passenger: its Node loader stops an app process by closing the process's stdin and
 * then (src/helper-scripts/node-loader.js `shutdown()`) emits 'exit' on the PhusionPassenger
 * object when the app listens for it, else `process.emit('message', 'shutdown')` when the app
 * has message listeners, else calls process.exit(0) right away. Without an 'exit' listener the
 * engine worker is never stopped and the signal registry never saved; SIGTERM only arrives later,
 * as Passenger's fallback for a process that does not exit.
 *
 * The bot's semantics, kept:
 *   first request   "🛑 Получен сигнал остановки — инициируем graceful shutdown (дедлайн 22с)..."
 *                   → the shutdown steps run, a 22 s deadline is armed; steps done → exit(0)
 *   second request  "🛑 Повторный сигнал остановки — выходим немедленно" → exit(0) at once
 *   deadline        "🛑 shutdown не завершился за 22с — принудительный выход (данные уже сохранены
 *                   на ранних шагах)" → exit(0) (the bot's line goes on about the Turso sync, which
 *                   the site does not have — D12)
 */

const SHUTDOWN_DEADLINE_S = 22.0;

/**
 * createStopRequest({ run, exit, log, setTimer, clearTimer, deadlineS })
 *   run(source)  async — the shutdown steps (engine stop, loops, DB close)
 *   exit(code)   process.exit by default
 * Returns { request(source) → Promise | null, stopping }.
 */
function createStopRequest({
  run, exit = (code) => process.exit(code), log,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h), deadlineS = SHUTDOWN_DEADLINE_S,
} = {}) {
  const warn = (m) => { try { (log.warn || log.warning || log.info).call(log, m); } catch (_e) { /* */ } };
  let stopping = false;
  let deadline = null;
  let done = null;

  function request(source = 'signal') {
    if (stopping) {
      warn('🛑 Повторный сигнал остановки — выходим немедленно');
      exit(0);
      return done;
    }
    stopping = true;
    try { log.info(`received ${source}, shutting down`); } catch (_e) { /* */ }
    try { log.info('🛑 Получен сигнал остановки — инициируем graceful shutdown (дедлайн 22с)...'); } catch (_e) { /* */ }
    deadline = setTimer(() => {
      warn('🛑 shutdown не завершился за 22с — принудительный выход (данные уже сохранены на ранних шагах)');
      exit(0);
    }, deadlineS * 1000);
    done = (async () => {
      try {
        await run(source);
      } catch (e) {
        try { log.error(`shutdown step failed: ${e && e.message}`); } catch (_e) { /* */ }
      }
      clearTimer(deadline);
      exit(0);
    })();
    return done;
  }

  return { request, get stopping() { return stopping; } };
}

/**
 * Wire the stop sources: SIGTERM / SIGINT on `proc`, and the PhusionPassenger 'exit' event when
 * running under Passenger. Returns the uninstall function (tests).
 */
function installStopHandlers(stop, { proc = process, passenger = null } = {}) {
  const onTerm = () => stop.request('SIGTERM');
  const onInt = () => stop.request('SIGINT');
  const onPassenger = () => stop.request('Passenger exit');
  proc.on('SIGTERM', onTerm);
  proc.on('SIGINT', onInt);
  const hasPassenger = Boolean(passenger && typeof passenger.on === 'function');
  if (hasPassenger) passenger.on('exit', onPassenger);
  return () => {
    proc.removeListener('SIGTERM', onTerm);
    proc.removeListener('SIGINT', onInt);
    if (hasPassenger && typeof passenger.removeListener === 'function') passenger.removeListener('exit', onPassenger);
  };
}

module.exports = { SHUTDOWN_DEADLINE_S, createStopRequest, installStopHandlers };
