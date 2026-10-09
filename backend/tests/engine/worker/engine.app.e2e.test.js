/**
 * M10 end to end: engine → app routes → tracker → SSE / notification → public feed.
 *
 *   1. The engine integration harness (engineHarness.js: the real engine worker over a
 *      MessageChannel, the three real scanners, fake WS feed with golden candles, the real
 *      main-thread delivery + notifier) produces delivered signals for the Pro test users over
 *      a 1h close (T1) and a 4h close (T4).
 *   2. While the engine runs (fake clock just past T4) the LEVELS 1h Pro user 611 reads them
 *      through the real HTTP stack (server.js → /api/app, JWT): GET dashboard, GET signals, and
 *      GET signals/{id}/chart, whose candles come from the worker's candle cache through the
 *      engine bridge's query RPC (what startEngine installs) and carry the levels as overlays.
 *      The landing's GET /api/public/feed (611 as the system track account) shows the T1 signal
 *      only once it is 60 minutes old, the T4 one not yet, and never a price level.
 *   3. The feed delivers the next ~40 h of golden bars into the candle cache; one tracker cycle
 *      (signalTracker over the real marketDataProvider) advances 611's T1 signal to TP1: the card
 *      outcome line, a `progress` notification linked to the signal, and the SSE events on 611's
 *      open GET /api/app/events stream (another user's stream gets nothing of it); GET signals
 *      now reports it as tp1.
 *   4. The public feed shows the TP1 only 60 minutes after the tracker recorded it (as a cursor
 *      `update` and in the page), with the levels still hidden.
 * No network: every market read is the harness's fake feed / REST client over golden candles.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { createRequire } from 'module';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-m10-app-e2e.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

const req = createRequire(import.meta.url);
const { runEngine, T1, T4 } = req('./engineHarness.js');
const { rawRequest } = await import('../../app/data/helpers.js');

const UID = 611;          // Pro, LEVELS 1h (LONG + SHORT)
const OTHER = 612;        // Pro, LEVELS 4h — must not see 611's stream
const quiet = { debug() {}, info() {}, warn() {}, warning() {}, error() {} };
const LEVEL_KEYS = ['entry', 'sl', 'tp1', 'tp2', 'tp3', 'tps', 'price', 'entry_lo', 'entry_hi', 'original_sl'];

let app; let authService; let appRouter; let appData; let bridge; let publicLanding; let createPublicTrack;
let server; let port;
const S = {};                                  // what the steps saw
const trackClock = { t: 0 };
let track = null;

async function getJson(target, token) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await rawRequest(port, { method: 'GET', target, headers });
  return { status: r.status, headers: r.headers, d: r.text ? JSON.parse(r.text) : null, text: r.text };
}

/** GET /api/app/events kept open; `frames` collects the parsed events. */
function openEvents(token) {
  const out = { frames: [], buf: '', waiters: [] };
  out.req = http.get({ host: '127.0.0.1', port, path: '/api/app/events', headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } }, (res) => {
    out.status = res.statusCode;
    out.headers = res.headers;
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      out.buf += chunk;
      let i;
      while ((i = out.buf.indexOf('\n\n')) >= 0) {
        const raw = out.buf.slice(0, i);
        out.buf = out.buf.slice(i + 2);
        const f = { raw };
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) f.event = line.slice(7);
          else if (line.startsWith('data: ')) f.data = (f.data === undefined ? '' : `${f.data}\n`) + line.slice(6);
          else if (line.startsWith('retry: ')) f.retry = Number(line.slice(7));
        }
        if (f.data !== undefined) { try { f.json = JSON.parse(f.data); } catch (_e) { /* text */ } }
        out.frames.push(f);
      }
      out.waiters = out.waiters.filter((w) => !(w.cond() && (w.resolve(), true)));
    });
  });
  out.until = (cond) => (cond() ? Promise.resolve() : new Promise((resolve) => out.waiters.push({ cond, resolve })));
  return out;
}

/** The first 15m bar after `from` that touches TP1 / SL of the row (golden candles, the tracker's 15m view). */
function firstTouch(G, row, from) {
  const f = G.loadFrame(row.symbol, '15m');
  const short = row.direction === 'SHORT';
  for (let i = 0; i < f.length; i++) {
    if (f.t[i] / 1000 < from) continue;
    const sl = short ? f.h[i] >= row.sl : f.l[i] <= row.sl;
    const tp1 = short ? f.l[i] <= row.tp1 : f.h[i] >= row.tp1;
    const tp2 = short ? f.l[i] <= row.tp2 : f.h[i] >= row.tp2;
    if (sl || tp1) return { open: f.t[i] / 1000, sl, tp1, tp2 };
  }
  return null;
}

beforeAll(async () => {
  app = (await import('../../../server.js')).default;
  authService = req('../../../services/authService.js');
  appRouter = req('../../../routes/app.js');
  appData = req('../../../routes/appData.js');
  bridge = req('../../../services/engine/engineBridge.js');
  publicLanding = req('../../../routes/publicLanding.js');
  ({ createPublicTrack } = req('../../../services/publicTrack/index.js'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  track = createPublicTrack({
    db: req('../../../models/database.js'), now: () => trackClock.t, log: quiet,
    env: { PUBLIC_TRACK_USER_IDS: `${UID}:e2e`, PUBLIC_TRACK_ID_SECRET: 'e2e-public-id-secret-0123456789abcdef', PUBLIC_API_RATE_PER_MIN: '0' },
    trend: { compute: async () => ({ empty: true, reason: 'e2e' }) },
  });
  publicLanding.setTrack(track);
  publicLanding.setClock(() => trackClock.t);

  S.run = await runEngine({
    vi,
    inspect: async (ctx) => {
      // the app routes read the worker's memory through the bridge, as startEngine wires it
      const methods = [];
      bridge.setRemote((method, args, timeoutMs) => { methods.push(method); return ctx.query(method, args, timeoutMs); });
      appData.configure({
        log: quiet,
        rest: {
          getCandles: (s, tf, limit) => ctx.fetcher.getCandles(s, tf, limit),
          async get24hChange(s) { const f = ctx.frameAt(s, '15m'); return f ? { last: f.c[f.length - 1], change_pct: 1.234 } : null; },
        },
      });
      appData.resetState();
      appRouter.resetRateLimits();
      try {
        S.now = ctx.at();
        const token = authService._signAccessToken(UID);
        S.rows = ctx.rowsOf().filter((r) => r.user_id === UID);
        S.levelsAll = ctx.rowsOf().filter((r) => r.strategy === 'LEVELS').length;
        S.dashboard = await getJson('/api/app/dashboard', token);
        S.signals = await getJson('/api/app/signals?status=all&limit=50', token);
        S.open = await getJson('/api/app/signals?status=open&strategy=levels', token);
        S.t1Row = S.rows.find((r) => r.created_at < T1 + 600);
        S.chart = await getJson(`/api/app/signals/${encodeURIComponent(S.t1Row.trade_id)}/chart`, token);
        S.chartFrame = ctx.frameAt(S.t1Row.symbol, '1H');
        S.foreignChart = await getJson(`/api/app/signals/${encodeURIComponent(ctx.rowsOf().find((r) => r.user_id === OTHER).trade_id)}/chart`, token);
        S.methods = methods.slice();
        // the landing feed during the run: 30 min after T1 nothing, just past T4 (60 min after T1) the T1 signal
        trackClock.t = T1 + 1800;
        S.feedEarly = await getJson('/api/public/feed');
        trackClock.t = S.now;
        S.feedAtT4 = await getJson('/api/public/feed');
      } finally {
        bridge.setRemote(null);
      }
    },
  });
}, 600_000);

afterAll(async () => {
  vi.useRealTimers();
  bridge.setRemote(null);
  publicLanding.setTrack(null);
  publicLanding.setClock(null);
  appData.configure({ clock: null, rest: null, log: null });
  if (server) await new Promise((r) => server.close(r));
});

describe('1–2. engine signals → the user\'s app routes (engine running, just past T4)', () => {
  it('the harness delivered LEVELS signals to the Pro user at T1 and T4 (cards in the feed)', () => {
    expect(S.rows.length).toBeGreaterThanOrEqual(2);
    expect(S.rows.every((r) => r.strategy === 'LEVELS' && r.signal_msg_id > 0 && !r.order_id)).toBe(true);
    expect(S.rows.some((r) => r.created_at >= T1 && r.created_at < T1 + 600)).toBe(true);
    expect(S.rows.some((r) => r.created_at >= T4 && r.created_at < T4 + 600)).toBe(true);
    const cards = S.run.notes.filter((n) => n.user_id === UID && n.type === 'signal');
    expect(cards.map((n) => n.id).sort((a, b) => a - b)).toEqual(S.rows.map((r) => r.signal_msg_id).sort((a, b) => a - b));
  });

  it('GET dashboard: the Mini App payload with the user\'s recent signals, live prices and the worker\'s trend', () => {
    const { status, d } = S.dashboard;
    expect(status).toBe(200);
    expect(Object.keys(d)).toEqual(['ok', 'stats', 'market', 'recent', 'trend', 'rating', 'market_trend']);
    expect(d.ok).toBe(true);
    expect(d.stats).toMatchObject({ days: 30, signals: S.rows.length });
    const ids = S.rows.slice().sort((a, b) => b.created_at - a.created_at).map((r) => r.trade_id);
    expect(d.recent.map((s) => s.id)).toEqual(ids.slice(0, 6));
    for (const s of d.recent) {
      expect(s).toMatchObject({ strategy: 'LEVELS', status: 'open' });
      expect(typeof s.price).toBe('number');                       // signal_freshness via the worker
    }
    expect(Object.keys(d.market).sort()).toEqual(['BTC', 'ETH']);
    // the LEVELS scanner's global trend lives in the worker: only the bridge RPC can answer it (the
    // main-thread fallback has no scanner → {})
    expect(Object.keys(d.trend)).toEqual(['BTC', 'ETH']);
    for (const c of ['BTC', 'ETH']) {
      expect(Object.keys(d.trend[c])).toEqual(['H1', 'H4', 'D1', 'W1']);
      for (const w of Object.values(d.trend[c])) expect(['up', 'down', 'flat', 'unknown']).toContain(w);
    }
    expect(d.market_trend).toEqual({});                          // no trend_monitor task in this run
    expect(d.rating.by_strategy.LEVELS.signals).toBe(S.levelsAll);       // [STRATEGY-RATING]: every user's LEVELS signals
    expect(S.levelsAll).toBeGreaterThan(S.rows.length);
  });

  it('GET signals: newest first, open filter + strategy', () => {
    expect(S.signals.status).toBe(200);
    expect(S.signals.d.strategy).toBe('ALL');
    expect(S.signals.d.signals.map((s) => s.id)).toEqual(S.dashboard.d.recent.map((s) => s.id));
    const t1 = S.signals.d.signals.find((s) => s.id === S.t1Row.trade_id);
    expect(t1).toMatchObject({ direction: S.t1Row.direction, entry: S.t1Row.entry, sl: S.t1Row.sl, tp1: S.t1Row.tp1, timeframe: '1h' });
    expect(S.open.d).toMatchObject({ ok: true, strategy: 'LEVELS' });
    expect(S.open.d.signals.length).toBe(S.rows.length);
  });

  it('GET signals/{id}/chart: candles from the worker\'s cache (bridge RPC) + the levels as overlays', () => {
    const { status, d } = S.chart;
    expect(status).toBe(200);
    expect(d.ok).toBe(true);
    expect(d.png).toBe(null);
    expect(S.methods).toEqual(expect.arrayContaining(['cachedCandles', 'currentPrices', 'marketTrend', 'globalTrend']));
    expect(d.candles.length).toBe(110);                                       // Pro window
    const f = S.chartFrame;
    const last = d.candles[d.candles.length - 1];
    expect(last).toEqual([f.t[f.length - 1], f.o[f.length - 1], f.h[f.length - 1], f.l[f.length - 1], f.c[f.length - 1], f.v[f.length - 1]]);
    expect(last[0] + 3600_000).toBeLessThanOrEqual(T4 * 1000);               // closed bars only
    expect(d.overlays).toMatchObject({ entry: S.t1Row.entry, sl: S.t1Row.sl, tps: [S.t1Row.tp1, S.t1Row.tp2, S.t1Row.tp3] });
    expect(d.overlays.emas.map((e) => e.label)).toEqual(['EMA 20', 'EMA 50', 'EMA 200']);
    expect(d.meta).toMatchObject({ strategy: 'LEVELS', direction: S.t1Row.direction });
    expect([S.foreignChart.status, S.foreignChart.d]).toEqual([404, { ok: false, error: 'not_found' }]);
  });

  it('public feed during the run: nothing 30 min after T1; at T4 + secs the T1 signal (60 min old) without levels, the T4 one not yet', () => {
    expect(S.feedEarly.status).toBe(200);
    expect(S.feedEarly.d).toMatchObject({ empty: true });
    const { d, text } = S.feedAtT4;
    expect(d).toMatchObject({ delay_min: 60, levels_hidden: true, source: 'paper' });
    expect(d.items).toHaveLength(1);
    const it0 = d.items[0];
    expect(Object.keys(it0)).toEqual(['id', 't', 'pair', 'bot_id', 'strategy', 'strategy_name', 'tf', 'side', 'status', 'path', 'r']);
    expect(it0).toMatchObject({ bot_id: 'e2e-levels', strategy: 'LEVELS', status: 'open', path: ['open'], r: null });
    expect(it0.t).toBe(Math.floor(S.t1Row.created_at) * 1000);       // whole seconds
    S.t1PubId = it0.id;
    for (const k of LEVEL_KEYS) expect(it0).not.toHaveProperty(k);
    for (const v of [S.t1Row.trade_id, String(S.t1Row.entry), String(S.t1Row.sl), String(S.t1Row.tp1)]) expect(text).not.toContain(v);
  });
});

describe('3–4. the tracker advances the T1 signal to TP1 → notification + SSE → the public feed 60 min later', () => {
  let target; let hit; let tc; let ev611; let ev612; let token; let page30; let page61; let poll;

  beforeAll(async () => {
    const G = req('../../golden/load.js');
    const db = req('../../../models/database.js');
    const candleCache = req('../../../services/marketData/candleCache.js');
    const ST = req('../../../services/engine/signalTracker.js');
    target = S.t1Row;
    hit = firstTouch(G, target, target.created_at);
    tc = hit.open + 900 + 120;                                    // two minutes after the hit bar closed
    // the feed delivers the bars closed by tc into the cache (the tracker's 15m / 1H / 4H views)
    const all = db.prepare('SELECT DISTINCT symbol FROM signal_trades').all().map((r) => r.symbol);
    for (const s of all) {
      for (const [tf, file] of [['15m', '15m'], ['1H', '1h'], ['4H', '4h']]) {
        const f = G.loadFrame(s, file).closedPrefix(file, tc * 1000, 300);
        if (f && f.length) candleCache.setCandles(s, tf, f, 3600);
      }
    }
    // the public track refreshes every minute; its last refresh before the cycle
    trackClock.t = tc - 30;
    await getJson('/api/public/feed');
    token = authService._signAccessToken(UID);
    ev611 = openEvents(token);
    ev612 = openEvents(authService._signAccessToken(OTHER));
    await ev611.until(() => ev611.frames.some((f) => f.event === 'hello'));
    await ev612.until(() => ev612.frames.some((f) => f.event === 'hello'));
    const tracker = ST.createSignalTracker({
      db, log: quiet, sleep: async () => {}, clock: () => tc,
      provider: ST.marketDataProvider({ cache: candleCache, rest: { async getCandles() { return null; } } }),
    });
    S.advanced = await tracker.runCycle(tc);
    await ev611.until(() => ev611.frames.filter((f) => f.json && f.json.trade_id === target.trade_id).length >= 2
      && ev611.frames.some((f) => f.event === 'notification' && f.json && String(f.json.link || '').includes(encodeURIComponent(target.trade_id))));
    appData.configure({ clock: () => tc + 60 });
    S.signalsAfter = await getJson('/api/app/signals?status=all&limit=50', token);
    // the minute refresh right after the cycle, then the feed 30 and 61 minutes later
    trackClock.t = tc + 60;
    const first = await getJson('/api/public/feed');
    S.cursor = first.d.cursor;
    trackClock.t = tc + 1800;
    page30 = await getJson('/api/public/feed');
    trackClock.t = tc + 3600 + 120;
    page61 = await getJson('/api/public/feed');
    poll = await getJson(`/api/public/feed?after=${encodeURIComponent(S.cursor)}`);
  }, 120_000);

  afterAll(() => {
    for (const e of [ev611, ev612]) if (e && e.req) e.req.destroy();
  });

  it('golden bars: the T1 signal touches TP1 (not the stop, not TP2) ~40 h later', () => {
    expect(hit).toMatchObject({ tp1: true, sl: false, tp2: false });
    expect(hit.open - target.created_at).toBeGreaterThan(3600);
  });

  it('one cycle: progress_stage TP1 (CAS), the card outcome line, a progress notification linked to the signal', () => {
    const db = req('../../../models/database.js');
    expect(S.advanced).toBeGreaterThanOrEqual(1);
    const row = db.prepare('SELECT * FROM signal_trades WHERE trade_id = ?').get(target.trade_id);
    expect(row.progress_stage).toBe('TP1');
    expect(row.progress_ts).toBeGreaterThanOrEqual(hit.open);
    expect(row.progress_ts).toBeLessThanOrEqual(tc);
    expect(row.result || '').toBe('');
    const card = JSON.parse(row.signal_card_json);
    expect(card.outcome).toMatchObject({ stage: 'TP1' });
    expect(card.html).toContain(card.outcome.line);
    const notes = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'progress' AND link = ?").all(UID, `/app/?tab=signals&id=${encodeURIComponent(target.trade_id)}`);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain('TP1');
  });

  it('SSE: 611\'s open stream gets the card edit, the notification and the notice; 612\'s gets none of it', () => {
    expect(ev611.status).toBe(200);
    expect(ev611.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(ev611.headers['x-accel-buffering']).toBe('no');
    const mine = ev611.frames.filter((f) => f.json && f.json.trade_id === target.trade_id);
    expect(mine.map((f) => [f.event, f.json.kind, f.json.stage])).toEqual([['progress', 'card', 'TP1'], ['progress', 'notice', 'TP1']]);
    expect(mine[0].json.outcome_line).toBeTruthy();
    expect(mine[1].json.reply_to).toBe(target.signal_msg_id);
    const note = ev611.frames.find((f) => f.event === 'notification' && f.json && String(f.json.link || '').includes(encodeURIComponent(target.trade_id)));
    expect(note.json).toMatchObject({ type: 'progress' });
    expect(ev612.frames.some((f) => f.json && f.json.trade_id === target.trade_id)).toBe(false);
    expect(ev612.frames.some((f) => f.event === 'notification' && String((f.json && f.json.link) || '').includes(encodeURIComponent(target.trade_id)))).toBe(false);
  });

  it('GET signals after the cycle reports the signal as tp1', () => {
    const s = S.signalsAfter.d.signals.find((x) => x.id === target.trade_id);
    expect(s).toMatchObject({ status: 'tp1' });
  });

  it('public feed: still open 30 min after the tracker recorded TP1, tp1 after 60 min; levels never shown', () => {
    const at30 = page30.d.items.find((x) => x.id === S.t1PubId);
    expect(at30).toMatchObject({ status: 'open', path: ['open'], r: null });
    const at61 = page61.d.items.find((x) => x.id === at30.id);
    expect(at61).toMatchObject({ status: 'tp1', path: ['open', 'tp1'], r: null });
    expect(page61.d).toMatchObject({ delay_min: 60, levels_hidden: true });
    for (const p of [page30, page61, poll]) {
      for (const v of [target.trade_id, String(target.entry), String(target.sl), String(target.tp1), String(target.tp2)]) expect(p.text).not.toContain(v);
    }
    for (const x of page61.d.items) for (const k of LEVEL_KEYS) expect(x).not.toHaveProperty(k);
    // the cursor taken right after the cycle: the TP1 arrives once, as an update
    const ups = poll.d.events.filter((e) => e.type === 'update' && e.id === at30.id);
    expect(ups).toEqual([{ type: 'update', id: at30.id, status: 'tp1', path: ['open', 'tp1'], r: null }]);
  });
});
