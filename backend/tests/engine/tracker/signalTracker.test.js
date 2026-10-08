/**
 * signalTracker.js — process_trade / mark_missed / expire_stale / run_cycle driven on the same
 * golden candles and the same fakes as the bot's signal_tracker.py in the venv
 * (gen/gen_tracker_vectors.py → fixtures/tracker_vectors.json):
 *   CAS calls, card edits (Telegram edit_message_text ↔ signal_card_json), progress notices
 *   (send_message ↔ notifier.dispatch, disable_notification ↔ silent), REST budget use and the
 *   [SIGNAL-PROGRESS*] / [CARD-OUTCOME] / [SIGNAL-MISSED*] / [SIGNAL-EXPIRE*] log lines.
 * e.g. python -c "import signal_tracker as st; print(st._pick_tfs(71*3600))"  → ('1H',)
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const T = nodeRequire('../../../services/engine/tracker.js');
const ST = nodeRequire('../../../services/engine/signalTracker.js');
const G = nodeRequire('../../golden/load.js');
const V = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'engine', 'tracker', 'fixtures', 'tracker_vectors.json'), 'utf8'));

const SYM = 'BTC-USDT-SWAP';
const golden = { '15m': G.loadFrame(SYM, '15m'), '1H': G.loadFrame(SYM, '1h') };

/** Rows of a golden frame whose open time (s) is in [first, last]. */
function window(frame, first, last) {
  let a = 0; while (a < frame.length && frame.t[a] / 1000 < first) a++;
  let b = a; while (b < frame.length && frame.t[b] / 1000 <= last) b++;
  return frame.slice(a, b);
}

/** FakeSrc of the generator: no memo, `get` returns the frame when it covers need_from. */
class FakeSrc extends ST.CandleSource {
  constructor(frames, { prices = null, restBudget = 20 } = {}) {
    super({}, { restBudget });
    this.frames = frames;
    this.calls = [];
    this.prices = prices;
  }
  async get(symbol, tf, needFrom) {
    this.calls.push([symbol, tf, needFrom]);
    const df = this.frames[tf] || null;
    return ST.covers(df, needFrom) ? df : null;
  }
  async lastPrice(symbol) {
    if (this.prices) return Object.prototype.hasOwnProperty.call(this.prices, symbol) ? this.prices[symbol] : null;
    return super.lastPrice(symbol);
  }
}

/** Fakes mirroring the generator's: CAS ok unless *_cas_fail; edits / sends in one ordered list. */
function harness({ forbidden = false, users = {}, trackable = [], expire = [], provider = {} } = {}) {
  const events = []; const advanced = []; const marked = []; const logs = []; const trk = [];
  const cards = new Map();
  const repo = {
    getTrackableSignals: (since, limit) => { trk.push([since, limit]); return trackable.map((r) => ({ ...r })); },
    getExpireCandidates: () => expire.map((r) => ({ ...r })),
    advanceSignalProgress: (tid, exp, st, pts) => { advanced.push([tid, exp, st, pts]); return !String(tid).endsWith('_cas_fail'); },
    markSignalExpired: (tid, exp, rr, pts) => { marked.push([tid, exp, rr, pts]); return !String(tid).endsWith('_cas_fail'); },
    saveCard: (tid, json) => { cards.set(tid, json); return true; },
  };
  const tradesById = new Map();
  const origSave = repo.saveCard;
  repo.saveCard = (tid, json) => {
    const tr = tradesById.get(tid) || {};
    events.push({ edit: JSON.parse(json).html, mid: Number(tr.signal_msg_id), chat: Number(tr.user_id) });
    return origSave(tid, json);
  };
  const notifier = {
    dispatch: async (uid, opts) => {
      if (forbidden) return { error: 'user_not_found' };
      events.push({ uid, text: opts.body, silent: opts.silent, type: opts.type, link: opts.link });
      return { dispatched: true, notificationId: events.length };
    },
  };
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: () => {} };
  const tracker = ST.createSignalTracker({
    repo, notifier, sse: null, log, provider, sleep: async () => {},
    getUser: (uid) => (Object.prototype.hasOwnProperty.call(users, String(uid)) ? users[String(uid)] : null),
  });
  const remember = (rows) => { for (const r of rows) tradesById.set(r.trade_id, r); };
  remember(trackable); remember(expire);
  return { tracker, events, advanced, marked, logs, trk, cards, remember };
}

/** Python sent list → the harness event shape. */
function pyEvents(sent) {
  return sent.map((s) => (s.edit !== undefined ? { edit: s.edit, mid: s.mid, chat: s.chat }
    : { uid: s.uid, text: s.text, silent: Boolean(s.disable_notification) }));
}
const jsEvents = (events) => events.map((e) => (e.edit !== undefined ? e : { uid: e.uid, text: e.text, silent: e.silent }));

function framesOf(spec) {
  const out = {};
  for (const [tf, [, first, last]] of Object.entries(spec)) out[tf] = window(golden[tf], first, last);
  return out;
}

describe('process_trade on golden candles (bot fakes)', () => {
  for (const c of V.process_trade) {
    it(c.name, async () => {
      const h = harness();
      h.remember([c.trade]);
      const src = new FakeSrc(framesOf(c.frames));
      const user = c.user === null ? null : c.user;
      const res = await h.tracker.processTrade({ ...c.trade }, user, src, c.now);
      expect(res).toBe(c.result);
      expect(h.advanced).toEqual(c.advanced);
      expect(jsEvents(h.events)).toEqual(pyEvents(c.sent));
      expect(src.calls).toEqual(c.src_calls);
      expect(h.logs).toEqual(c.log);
    });
  }
  it('Forbidden → blocked user; later notices skipped for that uid', async () => {
    const c = V.forbidden;
    const h = harness({ forbidden: true });
    h.remember([c.trade]);
    const [a, b] = c.frames['15m'];
    const src = new FakeSrc({ '15m': golden['15m'].slice(a, b), '1H': null });
    const user = { lang: 'ru', progress_notify_enabled: true, send_chart_enabled: false, sub_plan: 'pro', quiet_start: -1, quiet_end: -1 };
    expect(await h.tracker.processTrade({ ...c.trade }, user, src, c.now)).toBe(c.result);
    expect([...h.tracker.blockedUsers]).toEqual(c.blocked);
    expect(h.advanced).toEqual(c.advanced);
    expect(jsEvents(h.events)).toEqual(pyEvents(c.sent));
    expect(h.logs).toEqual(c.log);
  });
});

describe('mark_missed / expire_stale (bot fakes)', () => {
  it('MISSED only for the zone entry that ran ≥ 1R without a touch after 900 s', async () => {
    const c = V.mark_missed;
    const users = {}; for (const r of c.rows) users[String(r.user_id)] = { lang: 'ru' };
    const h = harness({ users });
    h.remember(c.rows);
    const src = new FakeSrc({ '15m': golden['15m'].slice(c.frame[0], c.frame[1]), '1H': null });
    const done = await h.tracker.markMissed(c.rows.map((r) => ({ ...r })), src, c.now);
    expect([...done].sort()).toEqual(c.done);
    expect(h.advanced).toEqual(c.advanced);
    expect(jsEvents(h.events)).toEqual(pyEvents(c.sent));
  });
  it('EXPIRED with the mark-to-market R clamp; no price / no risk / CAS lost → skipped', async () => {
    const c = V.expire_stale;
    const h = harness({ users: { 7: { lang: 'ru' } }, expire: c.rows });
    const src = new FakeSrc({}, { prices: c.price });
    expect(await h.tracker.expireStale(src, c.now)).toBe(c.count);
    expect(h.marked).toEqual(c.marked);
    expect(jsEvents(h.events)).toEqual(pyEvents(c.sent));
  });
});

describe('run_cycle end to end (bot fakes for DB, cache, REST, price, users)', () => {
  it('same CAS calls, expiries, card edits, notices, REST budget use and log lines', async () => {
    const c = V.run_cycle;
    const frame = (key, map) => {
      const [sym, tf] = key.split('|');
      const [first, last] = map[key];
      const g = G.loadFrame(sym, tf === '1H' ? '1h' : tf);
      return window(g, first, last);
    };
    const cache = {}; for (const k of Object.keys(c.cache)) cache[k] = frame(k, c.cache);
    const rest = {}; for (const k of Object.keys(c.rest)) rest[k] = frame(k, c.rest);
    const restCalls = [];
    const provider = {
      getCandles: (s, tf) => cache[`${s}|${tf}`] || null,
      fetchCandles: (s, tf, limit) => { restCalls.push([s, tf, limit]); return rest[`${s}|${tf}`] || null; },
      currentPrice: (s) => (Object.prototype.hasOwnProperty.call(c.prices, s) ? c.prices[s] : null),
    };
    const h = harness({ users: c.users, trackable: c.rows, expire: c.expire_rows, provider });
    const sent = await h.tracker.runCycle(c.now);
    expect(sent).toBe(c.sent_count);
    expect(h.trk).toEqual(c.trackable_calls);
    expect(h.advanced).toEqual(c.advanced);
    expect(h.marked).toEqual(c.marked);
    expect(restCalls).toEqual(c.rest_calls);
    expect(jsEvents(h.events)).toEqual(pyEvents(c.sent));
    expect(h.logs).toEqual(c.log);
    // site extras: notices link to the feed item and are typed 'progress'
    const notices = h.events.filter((e) => e.uid !== undefined);
    expect(notices.every((e) => e.type === 'progress' && e.link.startsWith('/app/?tab=signals&id='))).toBe(true);
  });
});

describe('pieces', () => {
  it('CandleSource: cache first, REST once per (symbol, tf) within the budget, memo', async () => {
    const f = golden['15m'].slice(100, 200);
    let restN = 0;
    const src = new ST.CandleSource({
      getCandles: (s) => (s === 'A' ? f : null),
      fetchCandles: () => { restN++; return f; },
    }, { restBudget: 1 });
    const need = f.t[0] / 1000;
    expect(await src.get('A', '15m', need)).toBe(f);
    expect(await src.get('A', '15m', need - 1)).toBe(null);        // memo: no refetch for an earlier need_from
    expect(restN).toBe(0);
    expect(await src.get('B', '15m', need)).toBe(f);               // cache miss → REST
    expect(await src.get('C', '15m', need)).toBe(null);            // budget exhausted
    expect(restN).toBe(1);
    expect(src.restLeft).toBe(0);
    expect(src.bars('A', '15m', f)).toBe(src.bars('A', '15m', f));
    expect(await src.lastPrice('A', need + 3600)).toBe(null);      // 1H not cached, no REST left
  });
  it('covers / lastClose / noticeTitle', () => {
    expect(ST.covers(null, 1)).toBe(false);
    expect(ST.covers([[5, 1, 1]], 5)).toBe(true);
    expect(ST.covers([[NaN, 1, 1]], 5)).toBe(false);
    expect(ST.lastClose([[1, 2, 3, 4]])).toBe(4);
    expect(ST.noticeTitle('🎯 <b>BTC LONG</b> — TP2 &amp; more\nx')).toBe('🎯 BTC LONG — TP2 & more');
    expect(ST.signalLink('a b')).toBe('/app/?tab=signals&id=a%20b');
  });
  it('the chart descriptor replaces the PNG when send_chart_enabled (client-side render, D3)', async () => {
    const c = V.process_trade.find((x) => x.name === 'A_tp1_tp2');
    const dispatched = [];
    const tracker = ST.createSignalTracker({
      repo: { advanceSignalProgress: () => true, saveCard: () => true },
      notifier: { dispatch: async (uid, o) => { dispatched.push(o); return { dispatched: true }; } },
      sse: null, log: { info: () => {}, warn: () => {}, debug: () => {} }, sleep: async () => {},
    });
    const src = new FakeSrc(framesOf(c.frames));
    await tracker.processTrade({ ...c.trade, timeframe: '5m' }, { ...c.user, send_chart_enabled: true, sub_plan: 'free' }, src, c.now);
    const chart = dispatched[0].data.chart;
    expect(chart).toMatchObject({ symbol: SYM, timeframe: '15m', candle_tf: '15m', event: 'TP2', hit_levels: ['TP1', 'TP2'], tier: 'free', strategy: 'LEVELS' });
    expect(chart.be_price).toBe(c.trade.entry);
    expect(chart.bars).toBeGreaterThanOrEqual(30);
    expect(dispatched[0].silent).toBe(false);
  });
  it('start() honours SIGNAL_TRACKER_ENABLED and arms after 120 s', () => {
    const logs = [];
    const off = ST.createSignalTracker({ repo: {}, config: { ...T.CONFIG, ENABLED: false }, log: { info: (m) => logs.push(m) } });
    expect(off.start()).toBe(false);
    expect(logs).toEqual(['[SIGNAL-PROGRESS] disabled (SIGNAL_TRACKER_ENABLED=0)']);
  });
});
