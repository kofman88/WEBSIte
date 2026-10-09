/**
 * /api/app per-user isolation and input hardening over HTTP (the real server stack):
 *   • IDOR: user A never sees user B's trades in any read (dashboard, signals in every filter,
 *     stats in every filter, share, challenge, me, settings) and cannot read or change them
 *     (chart / result on B's id, plain or URL-encoded → the bot's 404 not_found, B's row unchanged);
 *   • SQL injection through every parameter (query, path id, body fields): whitelisted or bound,
 *     the tables intact, hostile text stored verbatim where the bot stores text (note, feedback);
 *   • failures never leak: a handler exception carrying SQL / a stack answers aiohttp's 500 page.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { createRequire } from 'module';
import { setupEnv, insertUser, rawRequest } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('isolation');

const A = 951;
const B = 952;
const NOW = 1_760_000_000;
let db; let server; let port; let appRouter; let appData; let tokA; let SS;

beforeAll(async () => {
  db = nodeRequire('../../../models/database.js');
  const app = (await import('../../../server.js')).default;
  const authService = nodeRequire('../../../services/authService.js');
  const ts = nodeRequire('../../../services/traderSettingsService.js');
  appRouter = nodeRequire('../../../routes/app.js');
  appData = nodeRequire('../../../routes/appData.js');
  SS = nodeRequire('../../../services/engine/signalStats.js');
  for (const uid of [A, B]) { insertUser(db, uid); ts.getOrCreate(uid); }
  appRouter.setClock(() => NOW);
  appData.configure({
    clock: () => NOW,
    rest: { async getCandles() { return null; }, async get24hChange() { return null; } },
    log: { info() {}, warn() {}, debug() {}, error() {} },
  });
  tokA = authService._signAccessToken(A);
  const ins = db.prepare(`INSERT INTO signal_trades (trade_id, user_id, symbol, direction, entry, sl, original_sl, tp1, tp2, tp3,
    timeframe, strategy, created_at, signal_msg_id, progress_stage, progress_ts, result, user_note, order_id)
    VALUES (?, ?, ?, ?, 100, 98, 98, 103, 105, 108, '1h', ?, ?, 1, ?, ?, '', '', '')`);
  for (let i = 0; i < 12; i++) {
    ins.run(`a-trade-${i}`, A, 'AAAX-USDT-SWAP', 'LONG', ['LEVELS', 'SMC', 'VOLUME'][i % 3], NOW - 3600 * (i + 1), ['', 'TP1', 'SL', 'TP3'][i % 4], NOW - 1800 * (i + 1));
    ins.run(`b-trade-${i}`, B, 'BBBX-USDT-SWAP', 'LONG', ['LEVELS', 'SMC', 'VOLUME'][i % 3], NOW - 3600 * (i + 1), ['', 'TP1', 'SL', 'TP3'][i % 4], NOW - 1800 * (i + 1));
  }
  ins.run("b-quote'1", B, 'BBBX-USDT-SWAP', 'LONG', 'LEVELS', NOW - 7200, '', 0);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(async () => {
  appRouter.setClock(null);
  appData.configure({ clock: null, rest: null, log: null });
  await new Promise((r) => server.close(r));
});

beforeEach(() => { appRouter.resetRateLimits(); appData.resetState(); });

const H = () => ({ Authorization: `Bearer ${tokA}`, 'Content-Type': 'application/json' });
const get = (t) => rawRequest(port, { method: 'GET', target: `/api/app${t}`, headers: H() });
const post = (t, body) => rawRequest(port, { method: 'POST', target: `/api/app${t}`, headers: H(), body: typeof body === 'string' ? body : JSON.stringify(body) });
const bRows = () => db.prepare('SELECT trade_id, result, result_rr, user_note, skip_reason, state FROM signal_trades WHERE user_id = ? ORDER BY trade_id').all(B);
const counts = () => db.prepare('SELECT user_id, COUNT(*) n FROM signal_trades GROUP BY user_id ORDER BY user_id').all();

describe('IDOR: another user\'s trades', () => {
  it('no read of A shows anything of B', async () => {
    const reads = ['/dashboard', '/me', '/settings/all', '/challenge', '/stats', '/stats?days=365', '/stats?strategy=SMC&tf=1h'];
    for (const s of ['all', 'open', 'closed']) for (const st of ['', 'LEVELS', 'SMC', 'VOLUME']) reads.push(`/signals?status=${s}&limit=200&strategy=${st}`);
    for (const t of reads) {
      const r = await get(t);
      expect(r.status, t).toBe(200);
      expect(r.text, t).not.toMatch(/b-trade|BBBX|b-quote|"user_id":\s*952|\b952\b/);
    }
    const sig = JSON.parse((await get('/signals?limit=200')).text);
    expect(sig.signals.length).toBe(12);
    expect(sig.signals.every((s) => s.id.startsWith('a-trade-') && s.symbol === 'AAAX')).toBe(true);
    const share = await post('/share', { days: 30 });
    expect(share.text).not.toMatch(/b-trade|BBBX/);
    expect(JSON.parse(share.text).stats.signals).toBe(SS.signalStats(db, A, 30, NOW).signals);
  });

  it('chart / result on B\'s trade (plain, encoded, with a quote) → 404 not_found; B\'s rows unchanged', async () => {
    const before = bRows();
    const ids = ['b-trade-1', 'b-trade-2', encodeURIComponent('b-trade-3'), 'b%2Dtrade%2D4', "b-quote'1", encodeURIComponent("b-quote'1")];
    for (const id of ids) {
      const c = await get(`/signals/${id}/chart`);
      expect([id, c.status, JSON.parse(c.text)]).toEqual([id, 404, { ok: false, error: 'not_found' }]);
      appRouter.resetRateLimits();
      for (const body of [{ result: 'TP3' }, { note: 'mine now' }, { result: 'SKIP', note: 'x' }]) {
        const r = await post(`/signals/${id}/result`, body);
        expect([id, r.status, JSON.parse(r.text)]).toEqual([id, 404, { ok: false, error: 'not_found' }]);
      }
    }
    expect(bRows()).toEqual(before);
  });
});

describe('SQL injection through every parameter', () => {
  const INJ = ["' OR '1'='1", "LEVELS' OR 1=1--", '1; DROP TABLE signal_trades;--', "x') UNION SELECT * FROM users--", '%27%20OR%201%3D1', '"; DELETE FROM users; --'];

  it('query parameters of signals / stats are whitelisted or parsed, never spliced', async () => {
    const c0 = counts();
    for (const x of INJ) {
      const q = encodeURIComponent(x);
      for (const t of [`/signals?status=${q}`, `/signals?strategy=${q}`, `/signals?limit=${q}`, `/stats?days=${q}`, `/stats?strategy=${q}`, `/stats?tf=${q}`]) {
        const r = await get(t);
        expect(r.status, t).toBe(200);
        expect(r.text, t).not.toMatch(/b-trade|BBBX|password|email/);
      }
      const s = JSON.parse((await get(`/signals?strategy=${q}&limit=200`)).text);
      expect(s.strategy).toBe('ALL');
      expect(s.signals.length).toBe(12);
      expect(JSON.parse((await get(`/stats?tf=${q}`)).text).summary.trades).toBe(0);    // a tf no trade has
    }
    expect(counts()).toEqual(c0);
  });

  it('path ids and body fields: bound parameters; hostile text is stored verbatim like the bot', async () => {
    const c0 = counts();
    for (const x of INJ) {
      const id = encodeURIComponent(x);
      expect((await get(`/signals/${id}/chart`)).status).toBe(404);
      appRouter.resetRateLimits();
      expect((await post(`/signals/${id}/result`, { result: 'SL' })).status).toBe(404);
    }
    const note = "'); DELETE FROM signal_trades WHERE ('1'='1";
    const r = JSON.parse((await post('/signals/a-trade-0/result', { note })).text);
    expect(r.ok).toBe(true);
    expect(r.signal.note).toBe(note);
    expect(db.prepare("SELECT user_note FROM signal_trades WHERE trade_id = 'a-trade-0'").get().user_note).toBe(note);
    for (const body of [{ strategy: INJ[1], long: true }, { lang: INJ[0] }, { name: INJ[2] }, { symbol: INJ[3] }]) {
      for (const route of ['/strategy', '/lang', '/profile', '/analyze', '/settings', '/settings/all', '/challenge', '/trend/notify']) {
        appRouter.resetRateLimits();
        const res = await post(route, body);
        expect([200, 400, 404]).toContain(res.status);
        expect(res.text).not.toMatch(/SQLITE|syntax error|at Object\.|\/backend\//);
      }
    }
    const fbText = `${INJ[2]} long enough`;
    const fb = JSON.parse((await post('/feedback', { type: 'bug', text: fbText })).text);
    expect(fb.ok).toBe(true);
    const ticket = db.prepare('SELECT user_id, body FROM support_tickets WHERE id = ?').get(fb.id);
    expect(ticket).toEqual({ user_id: A, body: fbText });
    expect(counts()).toEqual(c0);
    expect(db.prepare('SELECT COUNT(*) n FROM users').get().n).toBeGreaterThanOrEqual(2);
  });
});

describe('failures never leak internals', () => {
  it('an exception with SQL in its message → aiohttp\'s 500 page, no message, no stack', async () => {
    const orig = SS.userSignals;
    SS.userSignals = () => {
      const e = new Error('SQLITE_ERROR: near "x": syntax error in SELECT * FROM signal_trades WHERE user_id=?');
      e.code = 'SQLITE_ERROR';
      throw e;
    };
    try {
      for (const accept of [undefined, 'text/html', 'application/json']) {
        const r = await rawRequest(port, { method: 'GET', target: '/api/app/signals', headers: { ...H(), ...(accept ? { Accept: accept } : {}) } });
        expect(r.status).toBe(500);
        expect(r.text).not.toMatch(/SQLITE|SELECT|signal_trades|Error:|at |\.js/);
        expect(r.text).toContain('Server got itself in trouble');
      }
    } finally {
      SS.userSignals = orig;
    }
  });
});
