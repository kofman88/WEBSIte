/**
 * The 60-minute delay of the public track is a hard bound (frontend/landing/README.md, Q5):
 * nothing the archive publishes can show a market event earlier than 60 minutes after it happened,
 * however late the tracker observes it — the tracker dates a stage by the open of the 15m / 1H bar
 * it happened in (signalTracker / tracker.replay, pickTfs never goes above 1H), the archive dates
 * it max(bar open, min(observed, bar open + LAG_MAX_S)) and shows it at that time + 60 min.
 *
 * Property test over simulated tracker histories: true event time e inside its bar, observation
 * lags from 0 to 8 h (restarts, catch-up), refresh every minute: at every V = now − 60 min no
 * published state reveals an event with e > V, and no signal created after V is visible.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { T0, makeDb, insertSignal, setStage, makeTrack } = require('./helpers.js');
const { DELAY_S, LAG_MAX_S } = require('../../services/publicTrack/config.js');

const H = 3600;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The stages a published status / path reveals (open reveals nothing). */
function revealed(status, path) {
  const out = new Set();
  for (const p of path || []) if (p !== 'open') out.add(p);
  if (status !== 'open') out.add(status);
  return out;
}
const STAGE_OF = { tp1: 'TP1', tp2: 'TP2', tp3: 'TP3', sl: 'SL', be: 'BE', tp1be: 'BE', tp2be: 'BE', missed: 'MISSED', exp: 'EXPIRED' };

describe('the delay bound holds for late observations', () => {
  it('config: the delay and the dating lag are constants of one hour', () => {
    expect(DELAY_S).toBe(3600);
    expect(LAG_MAX_S).toBe(3600);
  });

  it('the bound rests on the tracker dating stages by bars no wider than LAG_MAX_S (pickTfs: 15m / 1H)', () => {
    // with 4H bars the dating rule would show a stage up to 3 h early — the property test below fails then
    const T = require('../../services/engine/tracker.js');
    for (let age = 0; age <= 400 * H; age += 600) {
      for (const tf of T.pickTfs(age)) expect(T.TF_SEC[tf], `${tf} at age ${age}`).toBeLessThanOrEqual(LAG_MAX_S);
    }
  });

  for (const seed of [3, 11, 2026]) {
    it(`seed ${seed}: no published state shows an event earlier than its time + 60 min`, () => {
      const rnd = mulberry32(seed);
      const db = makeDb();
      const clock = { t: T0 };
      const pt = makeTrack(db, clock);
      const plans = [];                     // {row, events: [{s, e, pts, obs}]}
      for (let i = 0; i < 40; i++) {
        const created = T0 + Math.floor(rnd() * 20 * H / 60) * 60;
        const row = insertSignal(db, { created_at: created, user_id: rnd() < 0.5 ? 7 : 8, symbol: ['BTC', 'ETH', 'SOL'][i % 3] + '-USDT-SWAP' });
        const w = rnd() < 0.5 ? 900 : 3600;                 // the tracker's 15m / 1H bars
        const chain = rnd() < 0.5 ? ['TP1', 'TP2', rnd() < 0.5 ? 'TP3' : 'BE'] : [rnd() < 0.3 ? 'TP1' : 'SL'];
        let e = created + 300 + Math.floor(rnd() * 6 * H);
        let lastObs = created;
        const events = [];
        for (const s of chain) {
          const pts = Math.floor(e / w) * w;                // bar open of the event bar
          const lag = rnd() < 0.25 ? Math.floor(rnd() * 8 * H) : Math.floor(rnd() * 600);
          const obs = Math.max(lastObs + 60, e + lag);
          events.push({ s, e, pts: Math.max(pts, created + 1), obs });
          lastObs = obs;
          e += 60 + Math.floor(rnd() * 4 * H);
        }
        plans.push({ row, events, next: 0 });
      }
      const end = T0 + 40 * H;
      let checks = 0;
      for (clock.t = T0; clock.t <= end; clock.t += 120) {
        for (const p of plans) {
          while (p.next < p.events.length && p.events[p.next].obs <= clock.t) {
            const ev = p.events[p.next];
            setStage(db, p.row.trade_id, ev.s, ev.pts);
            p.next += 1;
          }
        }
        pt.current();
        const V = clock.t - DELAY_S;
        const pub = db.prepare('SELECT trade_id, created_at, status, path FROM public_track WHERE appear_seq IS NOT NULL').all();
        for (const r of pub) {
          expect(r.created_at, r.trade_id).toBeLessThanOrEqual(V);
          const p = plans.find((x) => x.row.trade_id === r.trade_id);
          for (const st of revealed(r.status, JSON.parse(r.path))) {
            const s = STAGE_OF[st];
            if (s === 'EXPIRED') continue;                   // by age (72 h) — not reached in 40 h
            const ev = p.events.find((x) => x.s === s) || (s === 'TP1' && p.events.find((x) => ['TP2', 'TP3', 'BE'].includes(x.s)));
            expect(ev, `${r.trade_id} shows ${st} that never happened`).toBeTruthy();
            expect(ev.e, `${r.trade_id} ${st}: event at ${ev.e}, shown at V=${V}`).toBeLessThanOrEqual(V);
            checks += 1;
          }
        }
      }
      expect(checks).toBeGreaterThan(500);
    });
  }
});
