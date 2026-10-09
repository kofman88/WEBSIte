/**
 * Runtime semantics of the engine loops vs the bot (fixtures/runtime_trace.json, produced by
 * gen/gen_runtime_trace.py from the bot's own health_monitor / volume_scanner on a virtual-time
 * CPython 3.11 loop), replayed on a virtual timer queue (vtimers.js):
 *
 *   stall    HealthMonitor.runForever over the scheduler's abortable sleep: after a 2000 s
 *            event-loop stall the overdue check fires once, late, at the end of the stall, then the
 *            loop sleeps a full 300 s again (no catch-up burst); the alerts carry the stall.
 *   volume   run_volume_scanner's 300 s cycle timeout: CPython 3.11 wait_for cancels the timed-out
 *            cycle and waits for it to end (bpo-32751) — the [VOLUME-CYCLE] warning, the heartbeat
 *            and the next cycle come after the cancelled one ended, never in parallel with it.
 *            (a) a cycle whose current await honours the cancellation (the scanner's own sleeps /
 *            checkpoints): the exact bot timeline; (b) a cycle inside a non-interruptible await (an
 *            in-flight REST call): it stops at its next checkpoint, 50 s later, and the rest of the
 *            timeline is the bot's shifted by those 50 s — still no overlap.
 *
 *   Python: cd <bot> && PYTHONDONTWRITEBYTECODE=1 BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> \
 *           <site>/backend/tests/engine/worker/gen/gen_runtime_trace.py
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const { createVirtualTimers } = req('./vtimers.js');
const S = req('../../../services/engine/scheduler.js');
const VS = req('../../../services/engine/volumeScanner.js');
const LS = req('../../../services/engine/levelsScanner.js');

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'runtime_trace.json'), 'utf8'));
const SC = FIX.scenario;

function capLog(sink, now) {
  const rec = (lvl) => (m) => sink.push([now(), 'log', lvl, String(m)]);
  return { debug() {}, info: rec('INFO'), warning: rec('WARNING'), warn: rec('WARNING'), error: rec('ERROR'), critical: rec('CRITICAL') };
}

describe('runtime semantics vs the bot (gen_runtime_trace.py, CPython 3.11)', () => {
  it('fixture from the production Python', () => {
    expect(FIX.python.startsWith('3.11.')).toBe(true);
  });

  it('event-loop stall: the overdue health check fires once at the end of the stall, then every 300 s (no catch-up burst)', async () => {
    const vt = createVirtualTimers();
    const ac = new AbortController();
    const lines = [];
    const alerts = [];
    const log = capLog(lines, vt.now);
    const bot = { alertAdmins: async (text) => { alerts.push([vt.now(), text]); return 1; } };
    const hm = new S.HealthMonitor(bot, { now: () => SC.t0 + vt.now(), log });
    vt.setTimer(() => hm.heartbeat('LEVELS'), SC.hb_at * 1000);
    vt.setTimer(() => vt.stall(SC.stall_s), SC.stall_at * 1000);
    const sleep = S.makeSleep(ac.signal, { setTimer: vt.setTimer, clearTimer: vt.clearTimer });
    const run = hm.runForever({ signal: ac.signal, sleep });
    await vt.runUntil(SC.stall_horizon - 1e-6);
    ac.abort();
    await vt.runUntil(SC.stall_horizon);
    await run;
    expect(alerts).toEqual(FIX.stall.alerts.map(([t, , text]) => [t, text]));
    expect(lines.map(([t, , lvl, m]) => [t, lvl, m])).toEqual(FIX.stall.logs.map(([t, , lvl, m]) => [t, lvl, m]));
    expect(FIX.stall.alerts.map((a) => a[0])).toEqual([720, 3000, 3300, 3600, 3900]);
  });

  /** run_volume_scanner over a stub cycle on the virtual queue; `interruptible` = how the cycle's awaits see a cancel. */
  async function volumeRun({ interruptible, cancelAt }) {
    const vt = createVirtualTimers();
    const timeline = [];
    const log = capLog(timeline, vt.now);
    const s = VS.createVolumeScanner({
      clock: { now: () => SC.t0 + vt.now(), monotonic: () => vt.now() },
      timers: vt.timers, sleep: vt.sleep, log, wsFeed: { registerOnBarClose() {} },
    });
    let n = 0;
    s._scanCycle = async (_b, _u, _f, token) => {
      const c = n++;
      timeline.push([vt.now(), 'start', c]);
      const [steps, stepS] = c === 0 ? [SC.vol_steps_first, SC.vol_step_s] : [1, SC.vol_step_later_s];
      for (let i = 0; i < steps; i++) {
        let off = null;
        await new Promise((resolve, reject) => {
          vt.setTimer(resolve, stepS * 1000);
          if (interruptible) { off = () => reject(new LS.CancelledError()); token.on(off); }
        }).catch((e) => { timeline.push([vt.now(), 'cancelled', c]); throw e; });
        if (off) token.off(off);
        if (token.cancelled) {                         // the cycle's checkpoint
          timeline.push([vt.now(), 'cancelled', c]);
          throw new LS.CancelledError();
        }
        timeline.push([vt.now(), 'step', c, i]);
      }
      timeline.push([vt.now(), 'end', c]);
    };
    const ac = new AbortController();
    vt.setTimer(() => ac.abort(), cancelAt * 1000);
    const health = { heartbeat: (name) => timeline.push([vt.now(), 'heartbeat', name]) };
    const run = s.runVolumeScanner(null, null, null, { health, intervalSec: SC.volume_interval_s, signal: ac.signal });
    await vt.runUntil(cancelAt + 1);
    const res = await run;
    return { timeline, res };
  }

  it('cycle timeout, interruptible cycle: the bot timeline exactly (cancelled → warning → heartbeat → next cycle)', async () => {
    const { timeline, res } = await volumeRun({ interruptible: true, cancelAt: SC.vol_cancel_at });
    expect(timeline).toEqual(FIX.volume.timeline);
    expect(res).toBeUndefined();          // stopped while waiting: silent (the bot's wait_for is outside the try)
  });

  it('cycle timeout, in-flight step: no overlap; the bot timeline shifted by the in-flight remainder', async () => {
    const shift = SC.vol_step_s * 5 - SC.volume_cycle_timeout_s;      // the 5th step ends 50 s after the timeout
    const { timeline } = await volumeRun({ interruptible: false, cancelAt: SC.vol_cancel_at + shift });
    const T = SC.volume_cycle_timeout_s;
    const want = FIX.volume.timeline.map((e) => (e[0] >= T ? [e[0] + shift, ...e.slice(1)] : e));
    expect(timeline).toEqual(want);
    // no cycle starts before the previous one has ended or been cancelled
    let open = null;
    for (const [, kind, c] of timeline) {
      if (kind === 'start') { expect(open).toBeNull(); open = c; }
      if (kind === 'end' || kind === 'cancelled') { expect(c).toBe(open); open = null; }
    }
  });

  it('a restarted run (_guarded_restart) leaves no abort listener of the previous run behind', async () => {
    const { getEventListeners } = req('events');
    const vt = createVirtualTimers();
    const s = VS.createVolumeScanner({
      clock: { now: () => SC.t0 + vt.now(), monotonic: () => vt.now() },
      timers: vt.timers, sleep: vt.sleep, log: capLog([], vt.now), wsFeed: { registerOnBarClose() {} },
    });
    const ac = new AbortController();
    s._scanCycle = async () => { throw new LS.CancelledError(); };      // each run ends at once ("stopped")
    for (let i = 0; i < 5; i++) await s.runVolumeScanner(null, null, null, { signal: ac.signal });
    expect(getEventListeners(ac.signal, 'abort').length).toBe(0);
  });
});
