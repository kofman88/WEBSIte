/**
 * Wire-level differential of the auto-trade port against the bot (execute_auto_trade + the four
 * traders + partial TP / reconcile / limit guard), over a STATEFUL fake of Bybit / BingX / Binance /
 * OKX (py/fake_exchanges.py: balances, positions, resting orders, fills, every error class).
 *
 * Fixture: py/drive_wire_diff.py ran the bot's own execute_auto_trade (CPython 3.11, its DB layer on
 * a temp SQLite, a virtual-time event loop: the clock only moves when every coroutine and pybit
 * thread is idle) for 64 seeded random users (WIRE_SEED 20261009) and the targeted cases (every
 * exchange × error class: insufficient margin, precision, rate limit, timeout before / after accept,
 * duplicate client id, position mode, delisted, auth, refused connection, HTML 502, the SL / TP / leverage
 * / batch / algo rejections on the main and the partial-TP path; precision edges — tiny tick / step,
 * 1000x coins, min notional; confirm mode, prop pilot, challenge daily stop, correlation cap, kill
 * switch, plan expired, slow exchanges past the executor timeouts) and recorded per logical task
 * every request (method, origin, target, body, signing headers — timestamps / signatures cut out and
 * the signature verified against the account secret), the answer it got, every message, log line,
 * trader log marker, metric and side effect, and afterwards the trades / users / engine kv /
 * trade_events / hedge-mode rows.
 *
 * Here every vector runs through the site's production entry point (services/autotrade
 * createAutoTrade) with the real site traders; each request a JS trader sends must be the next one
 * the bot sent in that task (the replay serves the bot's answer), and everything else must match.
 *
 * Regenerate (bot tree read-only):
 *   cd /home/user/MAIN_BOT/CHM_BREAKER_V4
 *   BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> <site>/backend/tests/autotrade/wire/py/drive_wire_diff.py \
 *     <site>/backend/tests/autotrade/wire/fixtures/wire_diff.json.gz
 *   rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const { loadFixture } = nodeRequire('./harness.js');
const { replay, compare } = nodeRequire('./compare.js');

const FX = loadFixture();
const EXCHANGES = ['bybit', 'bingx', 'binance', 'okx'];
const names = FX.vectors.map((v) => v.case.name);

describe(`wire differential — ${FX.vectors.length} scenarios replayed against the bot`, () => {
  it('fixture: CPython 3.11, the seed, ≥ 60 random users, every exchange × error class', () => {
    expect(FX.meta.python.startsWith('3.11.')).toBe(true);
    expect(FX.meta.seed).toBe(20261009);
    const rnd = names.filter((n) => /^rnd\d+_/.test(n));
    expect(rnd.length).toBeGreaterThanOrEqual(60);
    for (const ex of EXCHANGES) {
      expect(rnd.filter((n) => n.endsWith(`_${ex}`)).length, ex).toBeGreaterThanOrEqual(15);
      for (const cls of ['insufficient_margin', 'precision', 'rate_limit', 'timeout_after_accept', 'timeout_before_accept', 'duplicate',
        'position_mode', 'delisted', 'auth', 'connect', 'html_502']) {
        expect(names, `${ex} ${cls}`).toContain(`tgt_${ex}_${cls}`);
      }
      for (const fam of ['confirm', 'challenge_stop', 'prop', 'corr_cap', 'killswitch', 'plan_expired', 'filters_off', 'stale', 'sl_breached',
        'smc_split', 'auth_breaker', 'limit_fill_then_stop', 'slow_pre', 'slow_all', 'volume_market_ptp', 'rate_limit_balance']) {
        expect(names.some((n) => n.startsWith(`${fam}_${ex}`)), `${fam} ${ex}`).toBe(true);
      }
      expect(names.filter((n) => n.startsWith(`edge_${ex}_`)).length, `edges ${ex}`).toBeGreaterThanOrEqual(5);
      expect(names.filter((n) => n.startsWith(`tgt2_${ex}_`)).length, `path rejections ${ex}`).toBeGreaterThanOrEqual(8);
    }
    // the bot really traded: placements, partial-TP ladders, reconciles, limit guards and failures
    const tasks = new Set();
    let orders = 0;
    let hangs = 0;
    const badSig = new Set();
    for (const v of FX.vectors) {
      for (const [t, k, d] of v.expected.recs) {
        tasks.add(t.replace(/_\d+.*$/, '').replace(/\d+$/, ''));
        if (k !== 'req') continue;
        if (/order|batchOrders/.test(d.req.target) && d.req.method !== 'GET') orders += 1;
        if (d.resp.hang) hangs += 1;
        if (d.req.sig_ok === false) badSig.add(`${d.req.method} ${d.req.target.split('?')[0]}`);
      }
    }
    for (const t of ['call', 'partial_tp', 'limit_unfilled_guard', 'reconcile_ptp', 'reconcile_sl']) expect(tasks.has(t), t).toBe(true);
    expect(orders).toBeGreaterThan(300);
    expect(hangs).toBeGreaterThan(10);
    // the simulator never crashed (a crash would masquerade as an exchange answer)
    expect(FX.vectors.filter((v) => (v.expected.sim_errors || []).length).map((v) => v.case.name)).toEqual([]);
    // the only requests the exchange cannot verify are the two pinned bot quirks below
    expect([...badSig].sort()).toEqual(['GET /api/v5/account/balance', 'POST /fapi/v1/batchOrders']);
  });

  it('every scenario: results, per-task requests / messages / logs / markers / metrics / effects, trades, users, kv, events, hedge', async () => {
    const bad = [];
    for (const v of FX.vectors) {
      let diffs;
      try {
        diffs = compare(v, await replay(v));
      } catch (e) {
        diffs = [`threw ${e && e.stack}`];
      }
      if (diffs.length) bad.push({ name: v.case.name, diffs: diffs.slice(0, 4).map((d) => d.slice(0, 600)) });
    }
    expect(bad).toEqual([]);
  }, 600_000);

  describe('pinned bot quirks (the site does exactly the same on the wire)', () => {
    const vec = (n) => {
      const v = FX.vectors.find((x) => x.case.name === n);
      if (!v) throw new Error(`fixture lacks ${n}`);
      return v;
    };
    const reqs = (got, re) => got.recs.filter(([, k, d]) => k === 'req' && re.test(`${d.req.method} ${d.req.target}`)).map(([, , d]) => d.req);
    const msgs = (got) => got.recs.filter(([, k]) => k === 'msg').map(([, , d]) => d[1]);
    const markers = (got) => got.recs.filter(([, k]) => k === 'tlog').flatMap(([, , d]) => d[1]);
    const trade = (got, uid) => got.trades.find((t) => t.trade_id === `W${uid}-0`);

    it('Binance batchOrders: aiohttp/yarl re-quotes the signed urlencoded JSON (%3A → :, %20 → +) → -1022 every time → sequential fallback', async () => {
      const v = vec('tgt_binance_precision');
      const got = await replay(v);
      const [b] = reqs(got, /^POST \/fapi\/v1\/batchOrders/);
      expect(b.target).toContain('%22symbol%22:+%22');
      expect(b.sig_ok).toBe(false);
      expect(markers(got)).toContain('[BINANCE-ATOMIC-FALLBACK]');
      expect(reqs(got, /^POST \/fapi\/v1\/order\?/).length).toBeGreaterThan(0);
    });

    it('OKX fixed-amount balance check: get_balance without the passphrase → 50105 → «баланс нулевой», trade skipped', async () => {
      const v = vec('rnd03_okx');
      const got = await replay(v);
      const [b] = reqs(got, /^GET \/api\/v5\/account\/balance/);
      expect(b.headers['ok-access-passphrase']).toBe('');
      expect(msgs(got).some((m) => m.includes('баланс нулевой'))).toBe(true);
      expect(trade(got, v.case.uid)).toMatchObject({ result: 'SKIP', state: 'FAILED', order_id: '' });
    });

    it('OKX timeout after the exchange accepted: {"error": "timeout"} → SKIP while the position (with its attached SL) is open', async () => {
      const v = vec('tgt_okx_timeout_after_accept');
      const got = await replay(v);
      const sim = Object.values(v.expected.sim)[0];
      expect(sim.positions.length).toBe(1);
      expect(sim.orders.some((o) => o.type === 'STOP')).toBe(true);
      expect(trade(got, v.case.uid)).toMatchObject({ result: 'SKIP', state: 'FAILED', order_id: '' });
      expect(msgs(got).some((m) => m.startsWith('❌ <b>OKX ордер не выполнен</b>') && m.includes('<code>timeout</code>'))).toBe(true);
    });

    it('[BINGX-DUP-VERIFY] 101204 «Insufficient margin» on a clientOrderId order: the cid is looked up, not found → a real refusal, no phantom OPEN', async () => {
      const v = vec('tgt_bingx_insufficient_margin');
      const got = await replay(v);
      expect(Object.values(v.expected.sim)[0].positions).toEqual([]);
      const [q] = reqs(got, /^GET \/openApi\/swap\/v2\/trade\/order\?clientOrderId=chm_[0-9a-f]{12}&recvWindow=\d+&symbol=SOL-USDT$/);
      expect(q).toBeTruthy();
      expect(trade(got, v.case.uid)).toMatchObject({ result: 'SKIP', state: 'FAILED', order_id: '' });
      expect(msgs(got).some((m) => m.startsWith('❌ <b>BingX: ошибка открытия сделки</b>') && m.includes('Недостаточно средств'))).toBe(true);
      expect(msgs(got).some((m) => m.startsWith('✅'))).toBe(false);
    });

    it('Binance -4015 «Client order id is not valid» is taken as the duplicate success (order_id = the client id)', async () => {
      const v = vec('tgt_binance_duplicate');
      const got = await replay(v);
      const t = trade(got, v.case.uid);
      expect(t.state).toBe('OPEN');
      expect(t.order_id).toMatch(/^chm_[0-9a-f]{12}$/);
    });

    it('BingX 80001 «quantity precision is invalid» is humanised as «Неверный API ключ.»', async () => {
      const got = await replay(vec('tgt_bingx_precision'));
      expect(msgs(got).some((m) => m.endsWith('⚠️ Неверный API ключ.'))).toBe(true);
    });

    it('[OKX-LOT-CONTRACTS] below one lot: skipped without opt-in (no order), with opt-in boost the exchange minimum (1 lot = 0.1 contract = 100 DOGE)', async () => {
      const skip = await replay(vec('edge_okx_doge_9'));
      expect(reqs(skip, /^POST \/api\/v5\/trade\/order$/)).toEqual([]);
      expect(trade(skip, vec('edge_okx_doge_9').case.uid)).toMatchObject({ result: 'SKIP', state: 'FAILED' });
      const v = vec('edge_okx_doge_9_boost');
      const got = await replay(v);
      const [o] = reqs(got, /^POST \/api\/v5\/trade\/order$/);
      const body = JSON.parse(o.body);
      expect(body.sz).toBe('0.1');
      expect(body.attachAlgoOrds[0].sz).toBe('0.1');
      expect(trade(got, v.case.uid)).toMatchObject({ state: 'OPEN', qty: 100 });
      // partial-TP legs (60 / 40 DOGE) are below one lot: skipped, never sent as sz "0"
      expect(reqs(got, /^POST \/api\/v5\/trade\/order$/).length).toBe(1);
    });

    it('D6: execute_auto_trade answers executed=True although the exchange refused the order', async () => {
      const v = vec('tgt_bybit_insufficient_margin');
      const got = await replay(v);
      expect(got.results[0].ok.executed).toBe(true);
      expect(trade(got, v.case.uid).result).toBe('SKIP');
    });

    it('BingX batchOrders: production 100001 → legacy flow; an accepting endpoint → [BINGX-ATOMIC-OK]', async () => {
      expect(markers(await replay(vec('tgt_bingx_rate_limit')))).toContain('[BINGX-ATOMIC-FALLBACK]');
      const ok = await replay(vec('bx_batch_ok_bingx'));
      expect(markers(ok)).toContain('[BINGX-ATOMIC-OK]');
      expect(reqs(ok, /^POST \/openApi\/swap\/v2\/trade\/order\?/)).toEqual([]);
      expect(markers(await replay(vec('bx_batch_partial_bingx')))).toContain('[BINGX-ATOMIC-FALLBACK]');
    });

    it('a pybit call past the executor timeout: the coroutine stops at the await, the thread runs on (no metric / event after it)', async () => {
      const v = vec('slow_all_bybit');
      const got = await replay(v);
      expect(got.recs.some(([, k, d]) => k === 'metric' && d[0] === 'trade_placed')).toBe(false);
      expect(v.expected.recs.some(([, k, d]) => k === 'metric' && d[0] === 'trade_placed')).toBe(false);
      // the thread's own requests after the timeout are still on the wire (both sides)
      expect(reqs(got, /^POST \/v5\/order\/create/).length).toBe(v.expected.recs.filter(([, k, d]) => k === 'req' && d.req.target.startsWith('/v5/order/create')).length);
    });
  });

  it('no API secret in any message, log line, metric or stored row', async () => {
    const secrets = [];
    for (const v of FX.vectors) for (const [, sec, pp] of Object.values(v.case.keys || {})) { secrets.push(sec); if (pp) secrets.push(pp); }
    const sample = FX.vectors.filter((v, i) => i % 7 === 0);
    for (const v of sample) {
      const got = await replay(v);
      const text = JSON.stringify([got.results, got.recs.filter(([, k]) => k !== 'req'), got.trades, got.kv, got.events]);
      for (const s of secrets) expect(text.includes(s), `${v.case.name} leaks a secret`).toBe(false);
    }
  }, 300_000);
});
