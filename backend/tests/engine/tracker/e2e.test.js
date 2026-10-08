/**
 * End to end on the site's real DB (models/database + migrations), real notifier and SSE:
 * a delivered LEVELS signal_trades row + golden candles → runCycle → CAS to TP2, the card
 * outcome line in signal_card_json, a `progress` notification whose text is the bot's
 * (fixtures/tracker_vectors.json, scenario A_tp1_tp2), and the SSE events. Plus the repo's
 * SQL (db/signal_progress.py statements) on signal_trades.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-m10a-tracker-e2e.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

const nodeRequire = createRequire(import.meta.url);
const V = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'engine', 'tracker', 'fixtures', 'tracker_vectors.json'), 'utf8'));

let db; let ST; let sse; let ts; let G; let telegramService; let emailService;
beforeAll(() => {
  db = nodeRequire('../../../models/database.js');
  ST = nodeRequire('../../../services/engine/signalTracker.js');
  sse = nodeRequire('../../../services/sseService.js');
  ts = nodeRequire('../../../services/traderSettingsService.js');
  G = nodeRequire('../../golden/load.js');
  telegramService = nodeRequire('../../../services/telegramService.js');
  emailService = nodeRequire('../../../services/emailService.js');
  telegramService.send = async () => ({ sent: false, reason: 'not_linked' });
  emailService.send = async () => ({ ok: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM signal_trades').run();
  db.prepare('DELETE FROM notifications').run();
  db.prepare('DELETE FROM trader_settings').run();
  db.prepare('DELETE FROM users').run();
  ts.invalidateCache();
  sse._resetForTests();
});
afterEach(() => sse._resetForTests());

function makeUser() {
  const e = `u-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const ref = 'R' + Math.random().toString(36).slice(2, 9).toUpperCase();
  return Number(db.prepare("INSERT INTO users (email, password_hash, referral_code, locale) VALUES (?, 'x', ?, 'ru')").run(e, ref).lastInsertRowid);
}

function insertTrade(row) {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO signal_trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
}

function window(frame, first, last) {
  let a = 0; while (a < frame.length && frame.t[a] / 1000 < first) a++;
  let b = a; while (b < frame.length && frame.t[b] / 1000 <= last) b++;
  return frame.slice(a, b);
}

function fakeRes() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = () => {};
  res.write = (c) => { res.chunks.push(c); return true; };
  res.end = () => {};
  return res;
}

const events = (res) => res.chunks.filter((c) => c.startsWith('id:')).map((c) => {
  const lines = c.trim().split('\n');
  return { event: lines[1].slice(7), data: JSON.parse(lines.slice(2).map((l) => l.slice(6)).join('\n')) };
});

describe('delivered LEVELS signal → TP2: DB, card, notification, SSE', () => {
  it('one cycle does the whole chain once (CAS makes the second cycle a no-op)', async () => {
    const c = V.process_trade.find((x) => x.name === 'A_tp1_tp2');
    const uid = makeUser();
    ts.getOrCreate(uid);
    // the delivered card: a `signal` feed row whose id is signal_msg_id
    const notifier = nodeRequire('../../../services/notifier.js');
    const delivered = await notifier.dispatch(uid, { type: 'signal', title: 'BTC LONG', body: '<b>BTC LONG</b>\nкарточка' });
    const { trade_id: _tid, ...tr } = c.trade;
    insertTrade({
      ...tr, trade_id: 'e2e_1', user_id: uid, signal_msg_id: delivered.notificationId,
      signal_card_json: JSON.stringify({ html: '<b>BTC LONG</b>\nкарточка', actions: [], lang: 'ru' }),
      tp1_rr: 2.0, tp2_rr: 3.0, tp3_rr: 4.5, state: 'PENDING',
    });
    const res = fakeRes();
    sse.addClient(uid, res);
    const frames = {};
    for (const [tf, [, first, last]] of Object.entries(c.frames)) {
      frames[tf] = window(G.loadFrame('BTC-USDT-SWAP', tf === '1H' ? '1h' : tf), first, last);
    }
    const provider = { getCandles: (s, tf) => frames[tf] || null, fetchCandles: () => null, currentPrice: () => null };
    const tracker = ST.createSignalTracker({ db, provider, log: { info: () => {}, warn: () => {}, debug: () => {} }, sleep: async () => {} });

    expect(await tracker.runCycle(c.now)).toBe(1);
    const row = db.prepare('SELECT * FROM signal_trades WHERE trade_id = ?').get('e2e_1');
    expect([row.progress_stage, row.progress_ts, row.result]).toEqual(['TP2', c.advanced[0][3], '']);
    const card = JSON.parse(row.signal_card_json);
    const pyEdit = c.sent.find((s) => s.edit !== undefined).edit;
    expect(card.html).toBe(pyEdit);
    expect(card.outcome).toEqual({ stage: 'TP2', line: '🎯 TP2 достигнут · +3.0R', rr: 3.0 });
    expect(card.actions).toEqual([]);
    const notes = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'progress'").all(uid);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe(c.sent.find((s) => s.text !== undefined).text);
    expect(notes[0].title).toBe('🎯 BTC LONG — TP2 достигнут (+3R)');
    expect(notes[0].link).toBe('/app/?tab=signals&id=e2e_1');
    const ev = events(res);
    expect(ev.map((e) => e.event)).toEqual(['progress', 'notification', 'progress']);
    expect(ev[0].data).toMatchObject({ trade_id: 'e2e_1', kind: 'card', stage: 'TP2', outcome_line: '🎯 TP2 достигнут · +3.0R' });
    expect(ev[2].data).toMatchObject({ trade_id: 'e2e_1', kind: 'notice', stage: 'TP2', reply_to: delivered.notificationId });

    expect(await tracker.runCycle(c.now + 60)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM notifications WHERE type='progress'").get().n).toBe(1);
  });
});

describe('repo SQL (db/signal_progress.py)', () => {
  it('trackable / expire candidates filters, order, limit; CAS; set msg id', () => {
    const uid = makeUser();
    const base = { user_id: uid, symbol: 'X', direction: 'LONG', entry: 1, sl: 0.9, tp1: 1.1, tp2: 1.2, tp3: 1.3 };
    const now = 1_000_000;
    const rows = [
      { trade_id: 'ok1', created_at: now - 100, signal_msg_id: 5 },
      { trade_id: 'ok2', created_at: now - 50, signal_msg_id: 6, progress_stage: 'TP1', result: 'SKIP' },
      { trade_id: 'ok3', created_at: now - 10, signal_msg_id: 7, order_id: null },
      { trade_id: 'undelivered', created_at: now - 10, signal_msg_id: 0 },
      { trade_id: 'order', created_at: now - 10, signal_msg_id: 7, order_id: 'o1' },
      { trade_id: 'final', created_at: now - 10, signal_msg_id: 7, progress_stage: 'MISSED' },
      { trade_id: 'manual', created_at: now - 10, signal_msg_id: 7, result: 'TP2' },
      { trade_id: 'old', created_at: now - 73 * 3600, signal_msg_id: 7 },
      { trade_id: 'old_tp1', created_at: now - 80 * 3600, signal_msg_id: 7, progress_stage: 'TP1' },
      { trade_id: 'too_old', created_at: now - 97 * 3600, signal_msg_id: 7 },
      { trade_id: 'old_closed', created_at: now - 80 * 3600, signal_msg_id: 7, result: 'TRAIL' },
    ];
    for (const r of rows) insertTrade({ ...base, ...r });
    const repo = ST.createRepo(db);
    expect(repo.getTrackableSignals(now - 72 * 3600).map((r) => r.trade_id)).toEqual(['ok3', 'ok2', 'ok1']);
    expect(repo.getTrackableSignals(now - 72 * 3600, 2).map((r) => r.trade_id)).toEqual(['ok3', 'ok2']);
    expect(Object.keys(repo.getTrackableSignals(0)[0])).toEqual(['trade_id', 'user_id', 'symbol', 'direction', 'entry', 'sl',
      'original_sl', 'tp1', 'tp2', 'tp3', 'entry_lo', 'entry_hi', 'timeframe', 'strategy', 'created_at', 'signal_msg_id',
      'progress_stage', 'progress_ts', 'result', 'order_id', 'signal_card_json', 'expire_rr']);
    expect(repo.getExpireCandidates(now, 72 * 3600).map((r) => r.trade_id)).toEqual(['old_tp1', 'old']);
    expect(repo.advanceSignalProgress('ok1', '', 'TP1', 123)).toBe(true);
    expect(repo.advanceSignalProgress('ok1', '', 'TP2', 124)).toBe(false);          // CAS lost
    expect(repo.advanceSignalProgress('ok1', 'TP1', 'TP2', 125)).toBe(true);
    expect(repo.markSignalExpired('old_tp1', 'TP1', 0.5, now)).toBe(true);
    expect(repo.markSignalExpired('old_tp1', 'TP1', 0.7, now)).toBe(false);
    const e = db.prepare("SELECT progress_stage, progress_ts, expire_rr FROM signal_trades WHERE trade_id='old_tp1'").get();
    expect(e).toEqual({ progress_stage: 'EXPIRED', progress_ts: now, expire_rr: 0.5 });
    repo.setSignalMsgId('undelivered', 99, '{"html":"x"}');
    repo.setSignalMsgId('order', 0, 'ignored');
    repo.setSignalMsgId('', 5);
    const u = db.prepare("SELECT signal_msg_id, signal_card_json FROM signal_trades WHERE trade_id='undelivered'").get();
    expect(u).toEqual({ signal_msg_id: 99, signal_card_json: '{"html":"x"}' });
    repo.setSignalMsgId('undelivered', 100);
    expect(db.prepare("SELECT signal_msg_id, signal_card_json FROM signal_trades WHERE trade_id='undelivered'").get())
      .toEqual({ signal_msg_id: 100, signal_card_json: '{"html":"x"}' });
  });
});
