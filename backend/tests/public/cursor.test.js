/**
 * GET /api/public/feed?after=<cursor> semantics (services/publicTrack/feed.js):
 *   • every published change after the cursor arrives exactly once — `new` (became visible after
 *     the cursor, latest state) or `update`; no duplicates inside an answer or across answers;
 *   • no gaps: a client that applies the events holds the server's published state for every item;
 *   • the published state is the track as of now − 60 min (an independent oracle over the times
 *     the simulated tracker recorded each stage);
 *   • a restart continues the cursor; a cursor of another archive resynchronises; bad cursors throw.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { T0, makeDb, insertSignal, setStage, makeTrack, body } = require('./helpers.js');
const { BadCursor, parseCursor } = require('../../services/publicTrack/feed.js');
const { FEED_MAX_NEW } = require('../../services/publicTrack/config.js');

const H = 3600;
let db;
let clock;
beforeEach(() => {
  db = makeDb();
  clock = { t: T0 };
});

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

/** The landing's client: page → items by id; events applied like SEC.feed does. */
function makeClient(pt) {
  const page = body(pt.feed());
  const c = { cursor: page.cursor, items: new Map(), news: 0, joinSeq: page.cursor ? parseCursor(page.cursor).seq : 0 };
  for (const it of page.items || []) c.items.set(it.id, { status: it.status, path: it.path, r: it.r });
  c.poll = () => {
    const ans = body(pt.feed(c.cursor));
    const ids = ans.events.map((e) => (e.type === 'new' ? e.item.id : e.id));
    expect(new Set(ids).size, 'an id twice in one answer').toBe(ids.length);
    for (const e of ans.events) {
      if (e.type === 'new') {
        expect(c.items.has(e.item.id), `duplicate new ${e.item.id}`).toBe(false);
        c.items.set(e.item.id, { status: e.item.status, path: e.item.path, r: e.item.r });
        c.news += 1;
      } else if (c.items.has(e.id)) {
        c.items.set(e.id, { status: e.status, path: e.path, r: e.r });
      }
    }
    c.cursor = ans.cursor;
    return ans;
  };
  return c;
}

/** published states of the archive: pub_id → {status, path, r} */
function published() {
  const out = new Map();
  for (const r of db.prepare('SELECT pub_id, status, path, r FROM public_track WHERE appear_seq IS NOT NULL').all()) {
    out.set(r.pub_id, { status: r.status, path: JSON.parse(r.path), r: r.r });
  }
  return out;
}

describe('new / update events', () => {
  it('a signal that becomes visible is one `new`; its later change one `update`; nothing else', () => {
    const a = insertSignal(db, { created_at: T0 });
    const pt = makeTrack(db, clock);
    clock.t = T0 + H + 60;
    const cl = makeClient(pt);
    expect(cl.items.size).toBe(1);
    const b = insertSignal(db, { created_at: clock.t, symbol: 'ETH-USDT-SWAP' });
    clock.t += 60;
    expect(cl.poll().events).toEqual([]);                       // b is not 60 minutes old
    setStage(db, a.trade_id, 'TP1', clock.t - 300);
    clock.t += 60;
    pt.current();                                               // the minute timer sees TP1 now
    clock.t = b.created_at + H + 180;
    const ans = cl.poll();
    expect(ans.events.map((e) => e.type)).toEqual(['update', 'new']);
    expect(ans.events[0]).toMatchObject({ type: 'update', status: 'tp1', path: ['open', 'tp1'], r: null });
    expect(Object.keys(ans.events[0])).toEqual(['type', 'id', 'status', 'path', 'r']);
    expect(ans.events[1].item).toMatchObject({ pair: 'ETH/USDT', status: 'open' });
    expect(cl.poll().events).toEqual([]);                       // the same cursor again: nothing new
  });

  it('a change made before the client saw the item is folded into its `new` event', () => {
    insertSignal(db, { created_at: T0 - 60, symbol: 'XRP-USDT-SWAP' });
    const pt = makeTrack(db, clock);
    clock.t = T0 + H;
    const cl = makeClient(pt);
    const a = insertSignal(db, { created_at: T0 + H + 10 });
    clock.t = T0 + H + 70;
    setStage(db, a.trade_id, 'SL', clock.t);
    pt.feed();                                                  // seen at once, still not 60 min old
    clock.t = T0 + 3 * H;
    const ans = cl.poll();
    expect(ans.events).toHaveLength(1);
    expect(ans.events[0]).toMatchObject({ type: 'new', item: { status: 'sl', path: ['open', 'sl'] } });
  });

  it('several new items arrive oldest first (the landing prepends each); at most FEED_MAX_NEW', () => {
    insertSignal(db, { created_at: T0 - 60, symbol: 'XRP-USDT-SWAP' });
    const pt = makeTrack(db, clock);
    clock.t = T0 + H;
    const cl = makeClient(pt);
    for (let i = 0; i < FEED_MAX_NEW + 5; i++) insertSignal(db, { created_at: T0 + H + 10 + i });
    clock.t = T0 + 3 * H;
    const ans = cl.poll();
    const ts = ans.events.map((e) => e.item.t);
    expect(ts).toHaveLength(FEED_MAX_NEW);
    expect(ts).toEqual(ts.slice().sort((x, y) => x - y));
    expect(ts[ts.length - 1]).toBe((T0 + H + 10 + FEED_MAX_NEW + 4) * 1000);   // the newest are kept
  });
});

describe('randomised: no duplicates, no gaps, the delayed state', () => {
  for (const seed of [7, 42]) {
    it(`seed ${seed}: 3 clients over 80 h of a simulated tracker`, () => {
      const rnd = mulberry32(seed);
      const pt = makeTrack(db, clock);
      const STEP = 180;
      const live = [];                                            // {row, stage, hist: [{s, at}]}
      const clients = [];
      const startAt = [T0 + 2 * H, T0 + 20 * H, T0 + 50 * H];
      const nextPoll = [];
      const NEXT = { '': ['TP1', 'SL', 'ENTRY', 'MISSED'], ENTRY: ['TP1', 'SL'], TP1: ['TP2', 'BE'], TP2: ['TP3', 'BE'] };
      for (clock.t = T0; clock.t < T0 + 80 * H; clock.t += STEP) {
        if (rnd() < 0.12) {
          const row = insertSignal(db, {
            created_at: clock.t, user_id: rnd() < 0.5 ? 7 : 8, strategy: ['LEVELS', 'SMC', 'VOLUME'][Math.floor(rnd() * 3)],
            symbol: ['BTC', 'ETH', 'SOL', 'XRP'][Math.floor(rnd() * 4)] + '-USDT-SWAP', direction: rnd() < 0.5 ? 'LONG' : 'SHORT',
          });
          if (row.direction === 'SHORT') db.prepare('UPDATE signal_trades SET sl = 102, original_sl = 102, tp1 = 97, tp2 = 95, tp3 = 92 WHERE trade_id = ?').run(row.trade_id);
          live.push({ row, stage: '', hist: [] });
        }
        for (const L of live) {
          const age = clock.t - L.row.created_at;
          const opts = NEXT[L.stage];
          if (age >= 72 * H && ['', 'ENTRY', 'TP1', 'TP2'].includes(L.stage) && rnd() < 0.3) {
            setStage(db, L.row.trade_id, 'EXPIRED', clock.t, { expire_rr: Math.round((rnd() * 2 - 1) * 100) / 100 });
            L.stage = 'EXPIRED';
            L.hist.push({ s: 'EXPIRED', at: clock.t });
          } else if (opts && age > 300 && rnd() < 0.03) {
            const s = opts[Math.floor(rnd() * opts.length)];
            setStage(db, L.row.trade_id, s, clock.t - Math.floor(rnd() * 900));
            L.stage = s;
            L.hist.push({ s, at: clock.t });
          }
        }
        pt.current();                                             // the minute timer of start()
        clients.forEach((cl, i) => {
          if (clock.t >= nextPoll[i]) {
            cl.poll();
            nextPoll[i] = clock.t + (rnd() < 0.1 ? 6 * H : 30 + Math.floor(rnd() * 1200));
          }
        });
        startAt.forEach((t0, i) => {
          if (!clients[i] && clock.t >= t0) { clients[i] = makeClient(pt); nextPoll[i] = clock.t + 30; }
        });
      }
      clock.t += 61;
      clients.forEach((cl) => cl.poll());
      const pub = published();
      // no gaps: every client holds the published state of each item it has
      for (const cl of clients) {
        for (const [id, st] of cl.items) expect(st, id).toEqual(pub.get(id));
      }
      // every client received every item that appeared after its first page
      const all = db.prepare('SELECT pub_id, appear_seq FROM public_track WHERE appear_seq IS NOT NULL').all();
      for (const cl of clients) {
        const missing = all.filter((r) => r.appear_seq > cl.joinSeq && !cl.items.has(r.pub_id));
        expect(missing).toEqual([]);
        expect(cl.items.size).toBeGreaterThan(0);
      }
      // the published state is the track as of V = now − 60 min (independent oracle)
      const V = clock.t - H;
      const ids = new Map(db.prepare('SELECT trade_id, pub_id FROM public_track').all().map((r) => [r.trade_id, r.pub_id]));
      let checked = 0;
      for (const L of live) {
        const id = ids.get(L.row.trade_id);
        if (L.row.created_at > V) { expect(pub.has(id)).toBe(false); continue; }
        const seen = L.hist.filter((h) => h.at <= V);
        const s = seen.length ? seen[seen.length - 1].s : '';
        const tp2 = seen.some((h) => h.s === 'TP2');
        const expect1 = {
          '': V - L.row.created_at > 72 * H ? 'exp' : 'open', ENTRY: V - L.row.created_at > 72 * H ? 'exp' : 'open',
          TP1: 'tp1', TP2: 'tp1', TP3: 'tp3', SL: 'sl', BE: tp2 ? 'tp2be' : 'tp1be', MISSED: 'missed', EXPIRED: 'exp',
        }[s];
        expect(pub.get(id).status, `${L.row.trade_id} ${JSON.stringify(L.hist)}`).toBe(expect1);
        checked += 1;
      }
      expect(checked).toBeGreaterThan(50);
      expect(clients[0].news).toBeGreaterThan(30);
    });
  }
});

describe('restart, foreign archive, bad cursors', () => {
  it('a new process on the same archive continues the cursor (same epoch, no resync)', () => {
    insertSignal(db, { created_at: T0 });
    clock.t = T0 + 2 * H;
    const cl = makeClient(makeTrack(db, clock));
    const pt2 = makeTrack(db, clock);                  // restart
    const b = insertSignal(db, { created_at: clock.t });
    clock.t += 2 * H;
    const ans = body(pt2.feed(cl.cursor));
    expect(ans.events).toEqual([expect.objectContaining({ type: 'new' })]);
    expect(ans.events[0].item.t).toBe(b.created_at * 1000);
  });

  it('a cursor of another archive resynchronises from its view time: update for the known, new for the later', () => {
    insertSignal(db, { created_at: T0 });
    insertSignal(db, { created_at: T0 + 2 * H, symbol: 'ETH-USDT-SWAP' });
    clock.t = T0 + 4 * H;
    const pt = makeTrack(db, clock);
    const foreign = `zzzz.5.${T0 + H}`;
    const ans = body(pt.feed(foreign));
    expect(ans.events.map((e) => e.type)).toEqual(['update', 'new']);
    expect(ans.events[1].item.pair).toBe('ETH/USDT');
    expect(parseCursor(ans.cursor).epoch).not.toBe('zzzz');
    // a seq above the counter (archive reset) does the same
    const { epoch } = parseCursor(ans.cursor);
    expect(body(pt.feed(`${epoch}.999999.${T0 + H}`)).events.map((e) => e.type)).toEqual(['update', 'new']);
  });

  it('malformed cursors throw BadCursor', () => {
    const pt = makeTrack(db, clock);
    for (const bad of ['', 'x', 'abc.1', 'abc.-1.5', 'ABC.1.2', 'a b.1.2', ['a.1.2'], { a: 1 }, 'a.1.2.3', `${'a'.repeat(17)}.1.2`]) {
      expect(() => pt.feed(bad), JSON.stringify(bad)).toThrow(BadCursor);
    }
  });
});
