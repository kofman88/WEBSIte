/**
 * Multi-cycle parity of signalTracker.runCycle with the bot's REAL signal_tracker.run_cycle
 * (gen/gen_tracker_sim.py → fixtures/tracker_sim.json): 150 random delivered signals tracked
 * over ~100 h of irregular cycles on the same SQLite rows (db/signal_progress.py ↔ the repo),
 * the same 5m micro bars (MINSTD, regenerated here bit for bit) aggregated into 15m / 1H
 * frames that include the forming bar, the same cache modes (full / short → REST with a
 * budget of 3 / raising / missing) and price sources (cache / 1H fallback).
 * Every cycle must match: DB changes (progress_stage, progress_ts, expire_rr), card edits
 * (edit_message_text ↔ SSE card event + signal_card_json), progress notices (text, silent,
 * reply_to, photo ↔ chart), chart windows (_chart_df ↔ chart descriptor), REST calls, the
 * INFO/WARNING log lines and the return value.
 * Regenerate: BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python gen/gen_tracker_sim.py /abs/fixtures/tracker_sim.json
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const T = nodeRequire('../../../services/engine/tracker.js');
const ST = nodeRequire('../../../services/engine/signalTracker.js');
const { Frame } = nodeRequire('../../../strategies/common/frame.js');
const { engineDb, seedUsers } = nodeRequire('../stats/helpers.js');
const SIM = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'engine', 'tracker', 'fixtures', 'tracker_sim.json'), 'utf8'));

// ── the generator's MINSTD + micro bars (identical float arithmetic) ─────────
class Minstd {
  constructor(seed) { this.x = (seed % 2147483647) || 1; }
  u() { this.x = (this.x * 48271) % 2147483647; return this.x / 2147483647; }
}

const MICRO = SIM.MICRO;
const M0 = SIM.T0 - SIM.HIST_H * 3600;
const N_MICRO = Math.trunc(((SIM.HIST_H + SIM.SIM_H) * 3600) / MICRO);

function genMicro(seed, p0, vol) {
  const g = new Minstd(seed);
  let p = p0;
  const bars = [];
  for (let i = 0; i < N_MICRO; i++) {
    const t = M0 + i * MICRO;
    const u1 = g.u(); const u2 = g.u(); const u3 = g.u(); const u4 = g.u();
    const o = p;
    const c = o + (u1 - 0.5) * vol * o;
    let hi = Math.max(o, c) + u2 * vol * o * 0.5;
    let lo = Math.min(o, c) - u3 * vol * o * 0.5;
    if (u4 > 0.985) {
      hi = hi + vol * o * 3.0;
      lo = lo - vol * o * 3.0;
    }
    p = c;
    bars.push([t, o, hi, lo, c]);
  }
  return bars;
}

const MICROS = {};
SIM.symbols.forEach(([s, p0, vol], k) => { MICROS[s] = genMicro(1000 + k * 7919, p0, vol); });
const MODES = Object.fromEntries(SIM.symbols.map(([s, , , cm, pm]) => [s, [cm, pm]]));
const TFSEC = { '15m': 900, '1H': 3600 };

function frameRows(symbol, tf, now, limit) {
  const tfs = TFSEC[tf];
  const out = [];
  let cur = null;
  for (const [t, o, h, lo, c] of MICROS[symbol]) {
    if (t + MICRO > now) break;
    const b = Math.floor(t / tfs) * tfs;
    if (cur === null || cur[0] !== b) {
      if (cur !== null) out.push(cur);
      cur = [b, o, h, lo, c];
    } else {
      cur[2] = Math.max(cur[2], h);
      cur[3] = Math.min(cur[3], lo);
      cur[4] = c;
    }
  }
  if (cur !== null) out.push(cur);
  return out.slice(Math.max(0, out.length - limit));
}

const toFrame = (rows) => (rows.length ? Frame.fromBars(rows.map(([t, o, h, l, c]) => [t * 1000, o, h, l, c, 1.0])) : null);

describe('signalTracker.runCycle — multi-cycle simulation vs the bot run_cycle', () => {
  it(`${SIM.cycles.length} cycles over ${SIM.trades.length} signals match the bot cycle by cycle`, async () => {
    const db = engineDb();
    seedUsers(db, [...Object.keys(SIM.users).map((u) => [Number(u), 'pro']), [209, 'pro']]);
    const NOW = { t: SIM.T0 };
    const rest = []; const sends = []; const edits = []; const logs = [];
    const provider = {
      getCandles(symbol, tf) {
        const cm = MODES[symbol][0];
        if (cm === 'raise') throw new Error('cache down');
        if (cm === 'missing') return null;
        return toFrame(frameRows(symbol, tf, NOW.t, cm === 'full' ? 300 : 40));
      },
      fetchCandles(symbol, tf, limit) {
        rest.push([symbol, tf, limit]);
        if (symbol === 'DOGE-USDT-SWAP' && tf === '1H') return null;
        return toFrame(frameRows(symbol, tf, NOW.t, limit));
      },
      currentPrice(symbol) {
        if (MODES[symbol][1] === 'none') return null;
        const rows = frameRows(symbol, '15m', NOW.t, 2);
        return rows.length ? rows[rows.length - 1][4] : null;
      },
    };
    const users = Object.fromEntries(Object.entries(SIM.users).map(([k, v]) => [Number(k), v]));
    const notifier = {
      dispatch: async (uid, opts) => {
        if (uid === SIM.blocker) return { dispatched: false, error: 'user_not_found' };
        sends.push({ uid, text: opts.body, silent: opts.silent, reply_to: opts.data.reply_to, chart: opts.data.chart });
        return { dispatched: true, notificationId: sends.length };
      },
    };
    const sse = { broadcast: (uid, event, data) => { if (data.kind === 'card') edits.push({ uid, text: data.html, tid: data.trade_id }); } };
    const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: () => {} };
    const tracker = ST.createSignalTracker({
      db, provider, notifier, sse, log,
      getUser: (uid) => (Object.prototype.hasOwnProperty.call(users, uid) ? users[uid] : null),
      sleep: async () => {},
      clock: () => NOW.t,
      config: T.readConfig({ SIGNAL_TRACKER_REST_PER_CYCLE: '3', SIGNAL_TRACKER_SEND_DELAY_S: '0' }),
    });
    const cols = SIM.trade_cols;
    const ins = db.prepare(`INSERT INTO signal_trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    const byId = new Map(SIM.trades.map((t) => [t.trade_id, t]));
    const snapshot = () => new Map(db.prepare('SELECT trade_id, progress_stage, progress_ts, expire_rr FROM signal_trades').all()
      .map((r) => [r.trade_id, [r.progress_stage, r.progress_ts, r.expire_rr]]));
    let prev = new Map();
    let checked = 0;
    for (const cyc of SIM.cycles) {
      NOW.t = cyc.now;
      for (const tid of cyc.inserted) {
        const tr = byId.get(tid);
        ins.run(...cols.map((c) => (tr[c] === undefined ? null : tr[c])));
        prev.set(tid, [tr.progress_stage, tr.progress_ts, null]);
      }
      rest.length = 0; sends.length = 0; edits.length = 0; logs.length = 0;
      const sent = await tracker.runCycle(cyc.now);
      const cur = snapshot();
      const changes = {};
      for (const [tid, v] of cur) {
        const p = prev.get(tid);
        if (!p || p[0] !== v[0] || p[1] !== v[1] || p[2] !== v[2]) changes[tid] = v;
      }
      prev = cur;
      const at = `cycle now=${cyc.now}`;
      expect(changes, at).toEqual(cyc.changes);
      expect(logs, at).toEqual(cyc.logs);
      expect(rest, at).toEqual(cyc.rest);
      expect(sent, at).toBe(cyc.sent);
      expect(edits.map((e) => ({ uid: e.uid, text: e.text })), at).toEqual(cyc.edits.map((e) => ({ uid: e.uid, text: e.text })));
      // the keyboard of the snapshot is kept (bot: reply_markup restored from the snapshot)
      edits.forEach((e, i) => {
        const card = JSON.parse(db.prepare('SELECT signal_card_json AS j FROM signal_trades WHERE trade_id=?').get(e.tid).j);
        expect(Boolean(card.kb), at).toBe(cyc.edits[i].kb);
      });
      expect(sends.map((s) => ({ uid: s.uid, text: s.text, silent: s.silent, reply_to: s.reply_to, photo: s.chart !== null })), at)
        .toEqual(cyc.sends);
      const charts = sends.filter((s) => s.chart).map((s) => ({
        len: s.chart.bars, from_ts: s.chart.from_ts, event: s.chart.event, hit: s.chart.hit_levels, tier: s.chart.tier, lang: s.chart.lang,
      }));
      expect(charts, at).toEqual(cyc.renders.map((r) => ({ len: r.len, from_ts: r.from_ts, event: r.event, hit: r.hit, tier: r.tier, lang: r.lang })));
      checked += 1;
    }
    expect(checked).toBe(SIM.cycles.length);
    const final = Object.fromEntries([...snapshot()]);
    expect(final).toEqual(SIM.final);
    expect([...tracker.blockedUsers].sort()).toEqual(SIM.blocked);
  });
});
