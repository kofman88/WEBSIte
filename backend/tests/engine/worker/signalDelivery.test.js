/**
 * services/engine/signalDelivery.js — the main-thread side of the engine's Telegram calls and the
 * worker-side RPC client: what each bot call becomes on the site (notifier type / title / body /
 * link / silent / SSE payload), the on_sent commit (signal_msg_id + card snapshot), admin alerts,
 * and the RPC protocol over a real MessageChannel (answers, fire-and-forget calls, timeouts).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const Database = req('better-sqlite3');
const { createSignalDelivery, createRemoteDelivery, localFacade, RPC_METHODS, PLAN_LINK } = req('../../../services/engine/signalDelivery.js');
const { createSignalTradesRepo } = req('../../../services/engine/signalTradesRepo.js');
const { signalTradesDDL, TRADE_EVENTS_DDL } = req('../../../models/engineSchema.js');
const { smcKeyboard, trendKeyboard } = req('../../../services/engine/cards/keyboards.js');

const silentLog = { debug() {}, info() {}, warning() {}, warn() {}, error() {} };

function setup({ notFound = [], noId = [], throws = [] } = {}) {
  const tdb = new Database(':memory:');
  tdb.pragma('foreign_keys = OFF');
  tdb.exec(signalTradesDDL());
  tdb.exec(TRADE_EVENTS_DDL);
  tdb.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, is_admin INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1)');
  tdb.prepare('INSERT INTO users (id, is_admin, is_active) VALUES (1, 1, 1), (2, 0, 1), (3, 1, 0), (4, 1, 1)').run();
  const repo = createSignalTradesRepo({ db: tdb, now: () => 1767006000, log: silentLog });
  repo.addTrade({ trade_id: '9_1767006000000_123', user_id: 9, symbol: 'ETH-USDT-SWAP', direction: 'LONG', entry: 100, sl: 95, tp1: 110, tp2: 115, tp3: 120, strategy: 'SMC' });
  let nextId = 500;
  const calls = [];
  const sse = [];
  const notifier = {
    async dispatch(uid, opts) {
      calls.push([uid, opts]);
      if (throws.includes(uid)) throw new Error('db locked');
      if (notFound.includes(uid)) return { error: 'user_not_found' };
      return { dispatched: true, notificationId: noId.includes(uid) ? null : ++nextId, silent: Boolean(opts.silent) };
    },
  };
  const sseSvc = { broadcast: (uid, e, d) => { sse.push([uid, e, d]); return 1; }, broadcastAll: (e, d) => { sse.push(['*', e, d]); return 2; } };
  const d = createSignalDelivery({ notifier, sse: sseSvc, repo, db: tdb, log: silentLog });
  return { d, calls, sse, repo, tdb };
}

afterEach(() => { vi.useRealTimers(); });

describe('createSignalDelivery — the bot calls on the site', () => {
  it('card: feed row (type signal) + SSE payload + Telegram text, then on_sent: signal_msg_id + card snapshot', async () => {
    const { d, calls, repo } = setup();
    const text = '🟢 <b>ETH LONG</b> · SMC\nEntry 100';
    const keyboard = smcKeyboard('ETH-USDT-SWAP', '9_1767006000000_123', { lang: 'ru' });
    const ok = await d.deliver({ kind: 'card', type: 'signal', userId: 9, strategy: 'SMC', tradeId: '9_1767006000000_123', symbol: 'ETH-USDT-SWAP', direction: 'LONG', text, keyboard, lang: 'ru', protect: true, silent: true });
    expect(ok).toBe(true);
    expect(calls).toEqual([[9, {
      type: 'signal', title: '🟢 ETH LONG · SMC', body: text, tgText: text, link: '/app/?tab=signals&id=9_1767006000000_123', silent: true,
      data: { kind: 'card', trade_id: '9_1767006000000_123', strategy: 'SMC', symbol: 'ETH-USDT-SWAP', direction: 'LONG', html: text, actions: keyboard, lang: 'ru', silent: true },
    }]]);
    const row = repo.getTrade('9_1767006000000_123');
    expect(row.signal_msg_id).toBe(501);
    expect(JSON.parse(row.signal_card_json)).toEqual({ html: text, actions: keyboard, lang: 'ru' });
  });

  it('card to a deleted / inactive user → false, nothing committed (the bot\'s False from safe_send_message)', async () => {
    const { d, repo } = setup({ notFound: [9] });
    expect(await d.deliver({ kind: 'card', userId: 9, tradeId: '9_1767006000000_123', text: 'x' })).toBe(false);
    expect(repo.getTrade('9_1767006000000_123').signal_msg_id).toBe(0);
  });

  it('delivered without a feed row id (in-app insert failed) → true but no message id (mid = 0 → no remember)', async () => {
    const { d, repo } = setup({ noId: [9] });
    expect(await d.deliver({ kind: 'card', userId: 9, tradeId: '9_1767006000000_123', text: 'x' })).toBe(true);
    expect(repo.getTrade('9_1767006000000_123').signal_msg_id).toBe(0);
  });

  it('a throwing notifier → false; an empty text or user → false without a call', async () => {
    const { d, calls } = setup({ throws: [9] });
    expect(await d.deliver({ kind: 'card', userId: 9, text: 'x' })).toBe(false);
    expect(await d.deliver({ kind: 'card', userId: 0, text: 'x' })).toBe(false);
    expect(await d.deliver({ kind: 'card', userId: 9, text: '' })).toBe(false);
    expect(calls.length).toBe(1);
  });

  it('free preview: type signal, plan link, never silent, no row commit', async () => {
    const { d, calls } = setup();
    expect(await d.deliver({ kind: 'preview', type: 'signal', userId: 7, strategy: 'SMC', symbol: 'BTC-USDT-SWAP', direction: 'SHORT', text: '<b>Pro</b> preview', lang: 'en', silent: true })).toBe(true);
    expect(calls[0][1]).toMatchObject({ type: 'signal', title: 'Pro preview', link: PLAN_LINK, silent: false, data: { kind: 'preview', strategy: 'SMC', symbol: 'BTC-USDT-SWAP', direction: 'SHORT', lang: 'en' } });
  });

  it('auto-trade notices → type trade with the trade link; an unknown type falls back to trade', async () => {
    const { d, calls } = setup();
    await d.deliver({ kind: 'notice', type: 'trade', userId: 9, tradeId: 'T1', text: '🚫 <b>Авто-трейд SMC: сделка не открыта</b>\nETH LONG', keyboard: [[{ id: 'x', label: 'x', action: 'x', kind: 'callback' }]] });
    await d.deliver({ kind: 'notice', type: 'weird', userId: 9, text: 'limit' });
    expect(calls[0][1]).toMatchObject({ type: 'trade', title: '🚫 Авто-трейд SMC: сделка не открыта', link: '/app/?tab=signals&id=T1', data: { kind: 'notice', trade_id: 'T1' } });
    expect(calls[1][1]).toMatchObject({ type: 'trade', link: null });
  });

  it('chart: the descriptor over SSE `signal` {kind: chart} (D3), no DB write', () => {
    const { d, sse } = setup();
    expect(d.deliverChart({ userId: 9, tradeId: 'T1', strategy: 'SMC', lang: 'ru', symbol: 'ETH-USDT-SWAP', timeframe: '1H', bars: 300, lastTs: 1767002400000, extra: { ob_low: 1 } })).toBe(true);
    expect(sse).toEqual([[9, 'signal', { kind: 'chart', trade_id: 'T1', chart: { symbol: 'ETH-USDT-SWAP', timeframe: '1H', strategy: 'SMC', bars: 300, last_ts: 1767002400000, extra: { ob_low: 1 }, lang: 'ru' } }]]);
    expect(d.deliverChart({ userId: 0 })).toBe(false);
  });

  it('sendText: trend change (kind trend, quiet → silent, opt-out button), evening report → report', async () => {
    const { d, calls } = setup();
    const kb = trendKeyboard('ru');
    expect(await d.sendText(9, '📈 <b>BTC 1H</b>: UP', { silent: true, keyboard: kb, lang: 'ru', kind: 'trend', type: 'trend' })).toBe(true);
    expect(await d.sendText(9, 'Итоги дня', { type: 'report', kind: 'evening_report' })).toBe(true);
    expect(await d.sendText(9, 'x', { type: 'nope' })).toBe(true);
    expect(calls.map((c) => [c[1].type, c[1].silent, c[1].title])).toEqual([['trend', true, '📈 BTC 1H: UP'], ['report', false, 'Итоги дня'], ['report', false, 'x']]);
    expect(calls[0][1].data).toEqual({ kind: 'trend', html: '📈 <b>BTC 1H</b>: UP', actions: kb, lang: 'ru' });
  });

  it('alertAdmins: every active admin (users.is_admin = 1) gets a security notification; a failure skips that admin', async () => {
    const { d, calls } = setup({ throws: [4] });
    expect(await d.alertAdmins('💀 <b>scanner упала — авто-рестарт через 10s</b>\n<code>x</code>')).toBe(1);
    expect(calls.map((c) => c[0])).toEqual([1, 4]);
    expect(calls[0][1]).toEqual({ type: 'security', title: '💀 scanner упала — авто-рестарт через 10s', body: '💀 <b>scanner упала — авто-рестарт через 10s</b>\n<code>x</code>', tgText: '💀 <b>scanner упала — авто-рестарт через 10s</b>\n<code>x</code>', link: '/ops.html' });
  });

  it('RPC router: whitelisted methods only; rpc → rpc-result ok / error; call → no answer', async () => {
    const { d } = setup();
    expect(RPC_METHODS).toEqual(['deliver', 'deliverChart', 'sendText', 'sendMessage', 'alertAdmins', 'dispatch', 'broadcast', 'broadcastAll']);
    await expect(d.handleRpc('constructor', [])).rejects.toThrow('unknown delivery method: constructor');
    const replies = [];
    expect(d.handleWorkerMessage({ type: 'rpc', id: 4, method: 'broadcastAll', args: ['trend', { a: 1 }] }, (m) => replies.push(m))).toBe(true);
    expect(d.handleWorkerMessage({ type: 'rpc', id: 5, method: 'eval', args: [] }, (m) => replies.push(m))).toBe(true);
    expect(d.handleWorkerMessage({ type: 'call', method: 'broadcast', args: [9, 'progress', {}] }, (m) => replies.push(m))).toBe(true);
    expect(d.handleWorkerMessage({ type: 'heartbeat' }, () => {})).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(replies).toEqual([
      { type: 'rpc-result', id: 4, ok: true, result: 2 },
      { type: 'rpc-result', id: 5, ok: false, error: 'unknown delivery method: eval' },
    ]);
  });
});

describe('sendMessage — aiogram bot.send_message for the LEVELS / VOLUME safe_send_message port', () => {
  it('a card (site.tradeId): the signal_trades row names strategy / symbol / direction; lang from trader_settings; the Message answer', async () => {
    const { d, calls, repo, tdb } = setup();
    tdb.exec("CREATE TABLE trader_settings (user_id INTEGER PRIMARY KEY, lang TEXT)");
    tdb.prepare("INSERT INTO trader_settings (user_id, lang) VALUES (9, 'en')").run();
    const kb = [[{ id: 'sig_records', label: '📋', action: 'sig_records_9_1767006000000_123', kind: 'callback' }]];
    const res = await d.sendMessage(9, '🟢 <b>ETH LONG</b>', { parseMode: 'HTML', replyMarkup: kb, protectContent: true, disableNotification: true, site: { tradeId: '9_1767006000000_123' } });
    expect(res).toEqual({ ok: true, message: { message_id: 501, html: '🟢 <b>ETH LONG</b>', actions: kb, lang: 'en' } });
    expect(calls[0][1]).toMatchObject({ type: 'signal', silent: true, link: '/app/?tab=signals&id=9_1767006000000_123',
      data: { kind: 'card', trade_id: '9_1767006000000_123', strategy: 'SMC', symbol: 'ETH-USDT-SWAP', direction: 'LONG', actions: kb, lang: 'en', silent: true } });
    const row = repo.getTrade('9_1767006000000_123');
    expect(row.signal_msg_id).toBe(501);
    expect(JSON.parse(row.signal_card_json)).toEqual({ html: '🟢 <b>ETH LONG</b>', actions: kb, lang: 'en' });
  });

  it('a notice: site.type trade / report (default report); no trader_settings row → ru', async () => {
    const { d, calls } = setup();
    expect((await d.sendMessage(9, '🚫 <b>Авто-трейд: сделка не открыта</b>', { site: { type: 'trade' } })).ok).toBe(true);
    expect((await d.sendMessage(9, '💡 hint', { replyMarkup: [[{ id: 'a', label: 'a', action: 'a', kind: 'callback' }]] })).ok).toBe(true);
    expect((await d.sendMessage(9, 'x', { site: { type: 'nope' } })).ok).toBe(true);
    expect(calls.map((c) => [c[1].type, c[1].data.kind, c[1].data.lang, c[1].link])).toEqual([['trade', 'notice', 'ru', null], ['report', 'notice', 'ru', null], ['report', 'notice', 'ru', null]]);
  });

  it('failures carry the aiogram exception names safe_send_message branches on', async () => {
    const { d } = setup({ notFound: [9], throws: [7] });
    expect(await d.sendMessage(9, 'x', {})).toEqual({ ok: false, error: { name: 'TelegramForbiddenError', message: 'Telegram server says - Forbidden: user is deactivated' } });
    expect(await d.sendMessage(7, 'x', {})).toEqual({ ok: false, error: { name: 'TelegramBadRequest', message: 'Telegram server says - Bad Request: notification not stored' } });
    expect(await d.sendMessage(9, '', {})).toEqual({ ok: false, error: { name: 'TelegramBadRequest', message: 'Telegram server says - Bad Request: message text is empty' } });
  });

  it('remote / local facades: the Message, or the named error thrown; an unanswered request = TelegramNetworkError', async () => {
    const { MessageChannel } = req('worker_threads');
    const { d } = setup({ notFound: [5] });
    const f = localFacade(d);
    expect(await f.sendMessage(9, 'x', {})).toEqual({ message_id: 501, html: 'x', actions: null, lang: 'ru' });
    await expect(f.sendMessage(5, 'x', {})).rejects.toMatchObject({ name: 'TelegramForbiddenError' });
    const ch = new MessageChannel();
    ch.port2.on('message', (m) => d.handleWorkerMessage(m, (x) => ch.port2.postMessage(x)));
    const remote = createRemoteDelivery((m) => ch.port1.postMessage(m));
    ch.port1.on('message', (m) => remote.handleMessage(m));
    try {
      expect(await remote.sendMessage(9, 'y', { site: { type: 'trade' } })).toEqual({ message_id: 502, html: 'y', actions: null, lang: 'ru' });
      await expect(remote.sendMessage(5, 'y', {})).rejects.toMatchObject({ name: 'TelegramForbiddenError', message: 'Telegram server says - Forbidden: user is deactivated' });
    } finally {
      ch.port1.close();
      ch.port2.close();
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const silent = createRemoteDelivery(() => {}, { timeoutMs: 60_000 });
    const p = silent.sendMessage(1, 'x', {});
    const caught = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await caught).toMatchObject({ name: 'TelegramNetworkError', message: 'HTTP Client says - Request timeout error' });
  });

  it('through the bot safe_send_message: Forbidden → False (logged, no retry), a network timeout → retries 1 s / 2 s then False', async () => {
    const { safeSendMessage } = req('../../../services/engine/levelsScanner.js');
    const { d } = setup({ notFound: [5] });
    const f = localFacade(d);
    const lines = [];
    const tg = { debug() {}, info: (m) => lines.push(['INFO', m]), warning: (m) => lines.push(['WARNING', m]), error: (m) => lines.push(['ERROR', m]) };
    const sleeps = [];
    expect(await safeSendMessage(f, 5, 'x', {}, { log: tg, sleep: async (ms) => { sleeps.push(ms); } })).toBe(false);
    const stalled = { sendMessage: () => Promise.reject(Object.assign(new Error('HTTP Client says - Request timeout error'), { name: 'TelegramNetworkError' })) };
    expect(await safeSendMessage(stalled, 9, 'x', {}, { log: tg, sleep: async (ms) => { sleeps.push(ms); } })).toBe(false);
    expect(sleeps).toEqual([1000, 2000]);
    expect(lines).toEqual([
      ['INFO', '[TG-SAFE] uid=5 blocked bot — notification lost'],
      ['WARNING', '[TG-SAFE] uid=9 network err attempt 1/3: HTTP Client says - Request timeout error — backoff 1.0s'],
      ['WARNING', '[TG-SAFE] uid=9 network err attempt 2/3: HTTP Client says - Request timeout error — backoff 2.0s'],
      ['ERROR', '[TG-SAFE] uid=9 network err — all 3 attempts exhausted: HTTP Client says - Request timeout error'],
    ]);
  });
});

describe('createRemoteDelivery — the worker side of the protocol', () => {
  it('round trip over a real MessageChannel: deliver commits on the main side, dispatch returns the notifier answer', async () => {
    const { MessageChannel } = req('worker_threads');
    const { d, repo } = setup();
    const ch = new MessageChannel();
    ch.port2.on('message', (m) => d.handleWorkerMessage(m, (x) => ch.port2.postMessage(x)));
    const remote = createRemoteDelivery((m) => ch.port1.postMessage(m));
    ch.port1.on('message', (m) => remote.handleMessage(m));
    try {
      expect(await remote.deliver({ kind: 'card', userId: 9, tradeId: '9_1767006000000_123', text: 'card', lang: 'ru' })).toBe(true);
      expect(repo.getTrade('9_1767006000000_123').signal_msg_id).toBe(501);
      expect(await remote.notifier.dispatch(9, { type: 'progress', title: 't' })).toEqual({ dispatched: true, notificationId: 502, silent: false });
      expect(await remote.alertAdmins('x')).toBe(2);
      expect(remote.deliverChart({ userId: 9 })).toBe(true);
      expect(remote.sse.broadcast(9, 'progress', {})).toBe(0);
      expect(remote.pendingCount).toBe(0);
    } finally {
      ch.port1.close();
      ch.port2.close();
    }
  });

  it('an unanswered request resolves to its failure value after timeoutMs; failAll settles the rest', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const posted = [];
    const remote = createRemoteDelivery((m) => posted.push(m), { timeoutMs: 60_000 });
    const p1 = remote.deliver({ kind: 'card', userId: 1, text: 'x' });
    const p2 = remote.notifier.dispatch(1, {});
    const p3 = remote.alertAdmins('x');
    expect(posted.map((m) => [m.type, m.id, m.method])).toEqual([['rpc', 1, 'deliver'], ['rpc', 2, 'dispatch'], ['rpc', 3, 'alertAdmins']]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p1).toBe(false);
    expect(await p2).toEqual({ error: 'timeout' });
    expect(await p3).toBe(0);
    const p4 = remote.sendText(1, 'x');
    remote.failAll();
    expect(await p4).toBe(false);
    expect(remote.handleMessage({ type: 'rpc-result', id: 99, ok: true, result: 1 })).toBe(true);   // late answer: ignored
    const broken = createRemoteDelivery(() => { throw new Error('port closed'); });
    expect(await broken.deliver({ userId: 1, text: 'x' })).toBe(false);
  });

  it('an error answer resolves to the failure value; localFacade has the same shape in-process', async () => {
    const posted = [];
    const remote = createRemoteDelivery((m) => posted.push(m));
    const p = remote.deliver({ userId: 1, text: 'x' });
    remote.handleMessage({ type: 'rpc-result', id: posted[0].id, ok: false, error: 'boom' });
    expect(await p).toBe(false);
    remote.failAll();
    const { d } = setup();
    const f = localFacade(d);
    expect(Object.keys(f).sort()).toEqual(['alertAdmins', 'deliver', 'deliverChart', 'failAll', 'handleMessage', 'notifier', 'sendMessage', 'sendText', 'sse']);
    expect(await f.sendText(9, 'x', { type: 'trend' })).toBe(true);
  });
});
