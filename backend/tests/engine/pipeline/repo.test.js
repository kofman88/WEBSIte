/**
 * signalTradesRepo against the bot's db/trades.py, db/signal_progress.py, db/trade_events.py
 * and db/signals.py run on the same table (fixtures/repo.json, tools/gen_vectors.py `repo`;
 * the bot functions executed on fixtures/trades_ddl.sql = the site's signal_trades DDL):
 * every step compares the full table and trade_events after the call — the
 * _ALLOWED_TRADE_COLS whitelist, INSERT OR IGNORE, db_set_trade_result (CLOSED/FAILED
 * mapping, state_changed_at on every transition incl. unknown results, skip_reason[:64] only
 * after a real update, allow_overwrite_skip, closed_pnl_usd, position_closed events), the
 * monotonic state CAS, notes, signal_msg_id / card snapshot, trackable / expire queries,
 * progress CAS, trade events (payload ≤ 4000 chars), signals.py helpers, ghost cleanup.
 *
 *   Python: await dbt.db_add_trade({...}); await dbt.db_set_trade_result("t2", "TP1", 2.0) …
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const Database = req('better-sqlite3');
const { signalTradesDDL, TRADE_EVENTS_DDL, TRADE_FEEDBACK_DDL, SIGNAL_TRADES_ALLOWED_COLS } = req('../../../models/engineSchema.js');
const Repo = req('../../../services/engine/signalTradesRepo.js');
const { load, clock, captureLog } = req('./vectors.js');

const V = load('repo');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(signalTradesDDL());
  db.exec(TRADE_EVENTS_DDL);
  db.exec(TRADE_FEEDBACK_DDL);         // the bot DB has it: db_set_trade_result writes the trade_feedback row
  return db;
}

const parsed = (s) => { try { return { json: JSON.parse(s) }; } catch (_e) { return { raw: s }; } };
/** payload_json compared as JSON values (Python prints integral floats as 2.0, JS as 2). */
const normEvents = (evs) => evs.map((e) => ({ ...e, payload_json: e.payload_json === '' ? '' : parsed(e.payload_json), payload: undefined }));

describe('whitelist / states', () => {
  it('_ALLOWED_TRADE_COLS, TRADE_STATES, transitions, final stages', () => {
    expect([...SIGNAL_TRADES_ALLOWED_COLS].sort()).toEqual(V.allowed);
    expect([...Repo.TRADE_STATES].sort()).toEqual(V.states);
    expect(Object.fromEntries(Object.entries(Repo.ALLOWED_TRANSITIONS).map(([k, v]) => [k, [...v].sort()]))).toEqual(V.transitions);
    expect([...Repo.FINAL_STAGES].sort()).toEqual(V.final_stages);
    expect([...Repo.STOP_RESULTS]).toEqual(V.stop_results);
  });
});

describe('repo replay (bot table after every step)', () => {
  it(`${V.steps.length} steps`, () => {
    const db = freshDb();
    const c = clock(V.steps[0].now);
    const log = captureLog();
    const r = Repo.createSignalTradesRepo({ db, now: c.now, log });
    const base = V.base;
    const ops = {
      add_t1: () => r.addTrade({ ...base, trade_id: 't1', quality: 7, timeframe: '1h', breakout_type: 'Отскок', created_at: c.t, strategy: 'LEVELS',
        is_counter_trend: true, mtf_aligned: false, trend_ctx: 'with', state: 'PENDING', state_changed_at: c.t, original_sl: 98.0,
        signal_msg_id: 55, progress_stage: 'TP1', foo: 1, preset_name: null, signal_type: 'x'.repeat(70), rsi: 51.5, volume_ratio: 1.0 }),
      add_dup: () => r.addTrade({ ...base, trade_id: 't1', entry: 1.0 }),
      add_empty: () => r.addTrade({ foo: 1 }),
      add_t2: () => r.addTrade({ ...base, trade_id: 't2', direction: 'SHORT', entry_lo: 99.0, entry_hi: 101.0, created_at: c.t - 3600, strategy: 'SMC', state: 'PENDING', tp_placed: 1 }),
      add_t3: () => r.addTrade({ ...base, trade_id: 't3', created_at: c.t - 80 * 3600, strategy: 'VOLUME', state: 'PENDING', order_id: 'ex-1' }),
      add_t4: () => r.addTrade({ ...base, trade_id: 't4', created_at: c.t - 4 * 86400, strategy: 'LEVELS', state: 'PENDING' }),
      state_placing: () => r.setTradeState('t2', 'PLACING', { bumpAttempts: true }),
      state_open: () => r.setTradeState('t2', 'OPEN'),
      state_back: () => r.setTradeState('t2', 'PLACING'),
      state_bad: () => r.setTradeState('t2', 'WAT'),
      state_no_pred: () => r.setTradeState('t2', 'PENDING'),
      state_expected: () => r.setTradeState('t1', 'FAILED', { expectedFrom: ['PENDING', 'CLOSED'] }),
      result_tp1: () => r.setTradeResult('t2', 'TP1', 2.0),
      result_again: () => r.setTradeResult('t2', 'SL', -1.0),
      result_skip: () => r.setTradeResult('t3', 'SKIP', 0.0, { skipReason: 'not_delivered_' + 'y'.repeat(80) }),
      result_overwrite: () => r.setTradeResult('t3', 'TP2', 3.0, { closedPnlUsd: 12.5, allowOverwriteSkip: true }),
      result_unknown: () => r.setTradeResult('t4', 'LIQUIDATED', -2.0, { closedPnlUsd: -50 }),
      result_missing: () => r.setTradeResult('nope', 'SL', -1.0),
      note: () => r.setTradeNote('t1', { note: 'заметка '.repeat(80), skipReason: 'manual' }),
      note_none: () => r.setTradeNote('t1'),
      add_p1: () => r.addTrade({ ...base, trade_id: 'p1', created_at: c.t - 100, strategy: 'LEVELS', state: 'PENDING' }),
      add_p2: () => r.addTrade({ ...base, trade_id: 'p2', created_at: c.t - 200, strategy: 'SMC', state: 'PENDING', entry_lo: 99.5, entry_hi: 100.5 }),
      add_p3: () => r.addTrade({ ...base, trade_id: 'p3', created_at: c.t - 73 * 3600, strategy: 'VOLUME', state: 'PENDING' }),
      msg_p1: () => r.setSignalMsgId('p1', 101, '{"html": "<b>x</b> ✅", "kb": null}'),
      msg_p2: () => r.setSignalMsgId('p2', 102),
      msg_p3: () => r.setSignalMsgId('p3', 103, '{}'),
      msg_zero: () => r.setSignalMsgId('t4', 0, 'x'),
      trackable: () => r.getTrackableSignals(c.t - 72 * 3600),
      trackable_lim: () => r.getTrackableSignals(c.t - 100 * 3600, 1),
      advance_ok: () => r.advanceSignalProgress('p1', '', 'ENTRY', c.t - 50),
      advance_stale: () => r.advanceSignalProgress('p1', '', 'TP1', c.t - 40),
      advance_ok2: () => r.advanceSignalProgress('p1', 'ENTRY', 'TP1', c.t - 30),
      expire_cands: () => r.getExpireCandidates(c.t, 72 * 3600),
      expire_mark: () => r.markSignalExpired('p3', '', 0.42, c.t),
      expire_mark_again: () => r.markSignalExpired('p3', '', 0.5, c.t),
      trackable_after: () => r.getTrackableSignals(c.t - 100 * 3600),
      evt_add: () => r.addTradeEvent('p1', Repo.EVT.NOTIFICATION_SENT, { ok: true, uid: 7, rr: 1.5, n: 2.0, txt: 'привет', nested: { a: [1, null] } }),
      evt_empty: () => r.addTradeEvent('p1', Repo.EVT.FILTER_BLOCK, {}),
      evt_none: () => r.addTradeEvent('', Repo.EVT.FILTER_BLOCK, { x: 1 }),
      evt_long: () => r.addTradeEvent('p2', Repo.EVT.ANOMALY_DETECTED, { blob: 'ж'.repeat(5000) }),
      evt_get: () => r.getTradeEvents('p1'),
      evt_get_lim: () => r.getTradeEvents('t2', 1),
      signals_get: () => r.getSignal('p2'),
      signals_records: () => r.getSignalRecords('zzz'),
      signals_tp: () => r.updateSignalTp('p2', { tp2: 107.5 }),
      signals_record: () => r.addTradeRecord(7, 'p2', 'tp3', 4.5),
      user_trades: () => r.getUserTrades(7),
      evt_gc: () => r.gcTradeEvents(30),
      ghost_user: () => r.cleanupGhostTrades(7, 3),
    };
    // Python returns None for these (the JS returns change counts / booleans)
    const ignoreResult = new Set(['add_t1', 'add_dup', 'add_empty', 'add_t2', 'add_t3', 'add_t4', 'add_p1', 'add_p2', 'add_p3',
      'msg_p1', 'msg_p2', 'msg_p3', 'msg_zero', 'evt_add', 'evt_empty', 'evt_none', 'evt_long', 'signals_tp', 'signals_record']);
    for (const s of V.steps) {
      c.t = s.now;
      log.lines.length = 0;
      let res = null;
      let err = null;
      try { res = ops[s.name](); } catch (e) { err = e.name; }
      const where = s.name;
      expect(err !== null, `${where} error`).toBe(s.error !== null);
      if (!ignoreResult.has(s.name) && s.error === null) {
        const norm = (x) => (Array.isArray(x) && x.length && x[0] && x[0].event_type ? normEvents(x) : x);
        expect(norm(res), where).toEqual(norm(s.result));
      }
      expect(db.prepare('SELECT * FROM signal_trades ORDER BY trade_id').all(), where).toEqual(s.rows);
      expect(normEvents(db.prepare('SELECT * FROM trade_events ORDER BY id').all()), where).toEqual(normEvents(s.events));
      const pyLogs = s.logs.filter((l) => !/Persistent write connection/.test(l));
      expect(log.lines.filter((l) => l[0] === 'INFO' || l[0] === 'WARNING').map((l) => l[1]), where).toEqual(pyLogs);
    }
  });
});

describe('card snapshot', () => {
  it('signal_card_json ≤ 12000 chars, Python separators, empty without html', () => {
    const r = Repo.createSignalTradesRepo({ db: freshDb() });
    expect(r.cardSnapshot({ html: '<b>A</b> ✅', actions: [[{ id: 'x', label: 'Y', action: 'z', kind: 'callback' }]], lang: 'ru' }))
      .toBe('{"html": "<b>A</b> ✅", "actions": [[{"id": "x", "label": "Y", "action": "z", "kind": "callback"}]], "lang": "ru"}');
    expect(r.cardSnapshot({ html: '' })).toBe('');
    expect(r.cardSnapshot({ html: 'ж'.repeat(11900) }).length).toBe(11900 + 43);
    expect(r.cardSnapshot({ html: 'ж'.repeat(11990) })).toBe('');
  });
});
