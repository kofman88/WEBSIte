/**
 * Bot parity — the BingX WS bar state machine vs `ws_feed_bingx.BingXWebSocketFeed` driven the
 * same way the bot was in parity/gen/gen_ws_state.py: `_on_kline` / `_close_stale_bars` /
 * `_handle_message` with a fake REST fetcher and a fake clock. After every step the cache
 * (bars + expiry), bar state, last-emitted, bar-close events, counters, reservations, REST
 * calls and outbound frames must equal the bot's (parity/ws_state.json).
 *
 * Covered: initial load on the first forming push, 5 s forming throttle, close on a newer T,
 * late update of a closed bar, missing bar + out-of-order older bar, stale-bar timer
 * (T + tf + 15 s, no double close), REST refresh when the bar spans a reconnect, failed
 * initial load + [WS-REFILL] after 60 s (the closed bar in between is lost, like the bot),
 * ×1000 symbol scaling, trim to 300, and raw message parsing (acks, errors, Ping/Pong both
 * styles, unsubscribed pushes, close-time style T, dict payloads, malformed items).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { loadParity, sameNumbers, silentLog } from './parityHelpers.js';

const req = createRequire(import.meta.url);
const WS = req('../../services/marketData/bingxWsFeed.js');
const CC = req('../../services/marketData/candleCache.js');
const { Frame } = req('../../strategies/common/frame.js');
const fx = loadParity('ws_state.json');

function makeFetcher() {
  const q = Object.fromEntries(Object.entries(fx.rest).map(([k, v]) => [k, v.slice()]));
  const calls = [];
  return {
    calls,
    async getCandles(inst, tf, limit) {
      calls.push([inst, tf, limit]);
      const list = q[`${inst}|${tf}`];
      if (!list || !list.length) return null;
      const bars = list.length > 1 ? list.shift() : list[0];
      if (bars === null) return null;
      return Frame.fromBars(bars);
    },
  };
}

const normJson = (s) => (s.startsWith('{') ? JSON.stringify(JSON.parse(s)) : s);

describe('BingxWsFeed == ws_feed_bingx (scripted replay)', () => {
  it('matches the bot after every step', async () => {
    const clock = { t: 1700000000.0 };
    CC._resetForTests();
    CC.initCache(4000, { now: () => clock.t, log: silentLog });
    WS._resetBarCloseCallbacks();
    const events = [];
    WS.registerOnBarClose((inst, tf) => { events.push([inst, tf]); });
    const fetcher = makeFetcher();
    const fakeWs = { readyState: 1, sent: [], send(t) { this.sent.push(t); }, removeAllListeners() {}, close() {} };
    const feed = new WS.BingxWsFeed({
      fetcher, cache: CC, maxSubscriptions: 200, now: () => clock.t * 1000, sleep: async () => {}, log: silentLog, env: {},
    });

    const snapshot = () => {
      const cache = {};
      for (const [key, entry] of CC.getCache()._data) cache[key] = { bars: entry.value.toBars(), expires_at: entry.expiresAt };
      const barState = {};
      for (const [k, st] of feed._barState) barState[k] = { T: st.T, o: st.o, h: st.h, l: st.l, c: st.c, v: st.v, recv_ts: st.recvTs };
      return {
        cache,
        bar_state: barState,
        last_emitted: Object.fromEntries(feed._lastEmitted),
        events: events.slice(),
        counters: {
          candles_received_total: feed._candlesReceivedTotal, forming_skipped: feed._formingSkipped,
          pushes_received: feed._pushesReceived, pings_received: feed._pingsReceived, pongs_sent: feed._pongsSent,
          sub_errors: feed._subErrors, last_msg_ts: feed._lastMsgTs,
        },
        loaded_channels: Array.from(feed._loadedChannels).sort(),
        fetcher_calls: fetcher.calls.slice(),
        sent: fakeWs.sent.slice(),
        subscriptions: Array.from(feed._subscriptions.keys()).sort(),
      };
    };

    const lastBars = {};
    for (let i = 0; i < fx.steps.length; i++) {
      const { step, state: exp } = fx.steps[i];
      switch (step.op) {
        case 'clock': clock.t = step.t; break;
        case 'subscribe': feed.subscribe(step.inst, step.tf); break;
        case 'kline': await feed._onKline(WS.keyOf(step.inst, step.tf), step.T, step.o, step.h, step.l, step.c, step.v); break;
        case 'stale': await feed._closeStaleBars(step.now_ms); break;
        case 'reconnect': feed._connectedAt = feed._nowS(); break;
        case 'settle': await feed.settle(); break;
        case 'attach_ws': feed._ws = fakeWs; break;
        case 'message': await feed.handleMessage(step.text); break;
        case 'unsubscribe_check': feed._ws = null; feed.unsubscribe('SOL-USDT-SWAP', '15m'); break;
        default: throw new Error(`unknown op ${step.op}`);
      }
      // the bot's background REST refresh (asyncio task) only runs at the next await; the JS
      // promise may already have settled — compare after the explicit `settle` step instead
      if (fx.steps[i + 1] && fx.steps[i + 1].step.op === 'settle') continue;
      const js = snapshot();
      const label = `step ${i} ${JSON.stringify(step).slice(0, 80)}`;
      expect(Object.keys(js.cache).sort(), `${label} cache keys`).toEqual(Object.keys(exp.cache).sort());
      for (const [key, e] of Object.entries(exp.cache)) {
        const bars = e.same ? lastBars[key] : e.bars;
        lastBars[key] = bars;
        expect(js.cache[key].bars.length, `${label} ${key} length`).toBe(bars.length);
        for (let b = 0; b < bars.length; b++) sameNumbers(js.cache[key].bars[b], bars[b], `${label} ${key}[${b}]`);
        expect(js.cache[key].expires_at, `${label} ${key} expires`).toBe(e.expires_at);
      }
      expect(js.bar_state, `${label} bar_state`).toEqual(exp.bar_state);
      expect(js.last_emitted, `${label} last_emitted`).toEqual(exp.last_emitted);
      expect(js.events, `${label} events`).toEqual(exp.events);
      expect(js.counters, `${label} counters`).toEqual(exp.counters);
      expect(js.loaded_channels, `${label} loaded_channels`).toEqual(exp.loaded_channels);
      expect(js.fetcher_calls, `${label} fetcher_calls`).toEqual(exp.fetcher_calls);
      expect(js.sent.map(normJson), `${label} sent`).toEqual(exp.sent.map(normJson));
      expect(js.subscriptions, `${label} subscriptions`).toEqual(exp.subscriptions);
    }
    expect(fx.steps.length).toBeGreaterThan(70);
    CC._resetForTests();
    WS._resetBarCloseCallbacks();
  });
});
