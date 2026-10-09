/**
 * smcScanner unit tests — the bot behaviours and quirks of smc/scanner.py pinned on hand-built
 * inputs (the PY311 differential replay is smcScanner.diff.test.js). The pure engine is faked
 * (deps.engine) so each test controls the signal; the registry, free report, confluence and the
 * signal_trades repo are the real modules on in-memory stores.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const Database = req('better-sqlite3');
const { Frame } = req('../../../strategies/common/frame.js');
const { signalTradesDDL, TRADE_EVENTS_DDL } = req('../../../models/engineSchema.js');
const { createSignalTradesRepo } = req('../../../services/engine/signalTradesRepo.js');
const { createSignalRegistry } = req('../../../services/engine/signalRegistry.js');
const { createFreeReport } = req('../../../services/engine/freeReport.js');
const { createSignalConfluence } = req('../../../services/engine/signalConfluence.js');
const pf = req('../../../config/planFeatures.js');
const access = req('../../../services/engine/userAccess.js');
const S = req('../../../services/engine/smcScanner.js');
const { memKv, captureLog } = req('../pipeline/vectors.js');

const T0 = 1767006000;   // 2025-12-29 11:00 UTC

function frame(n = 60, p = 100) {
  const bars = [];
  for (let i = 0; i < n; i++) bars.push([1_766_000_000_000 + i * 3_600_000, p, p * 1.01, p * 0.99, p, 1000]);
  return Frame.fromBars(bars);
}

function user(uid, over = {}) {
  return {
    user_id: uid, sub_plan: 'pro', sub_status: 'active', sub_expires: 2e9, strategy: 'SMC', extra_strategies: '',
    smc_long_active: true, smc_short_active: true, long_active: false, short_active: false, active: false,
    smc_cfg: '{}', lang: 'ru', signal_format: 'full', send_chart_enabled: true, quiet_start: -1, quiet_end: -1,
    trade_risk_pct: 1.0, trade_leverage: 10, trade_exchange: 'bybit', auto_trade: false, auto_trade_mode: 'confirm',
    free_smc_preview_today: 0, free_smc_preview_date: '', smc_max_sl_pct: 5.0, smc_counter_trend_min_quality: 4,
    allow_counter_trend: false, filters_all_off: false, high_wr_mode: false, optimizer_enabled: false,
    genome_auto_apply: false, vol_filter_mode: 'usdt', max_coins_count: 50, bybit_demo: false, max_trades_limit: 5,
    ...over,
  };
}

function sigFor(symbol, direction, score = 4, kw = {}) {
  const long = direction === 'LONG';
  return {
    symbol, direction, score, grade: { 5: '🔥 A+', 4: '✅ A', 3: '⚡ B' }[score] || `⚡ ${score}/5`,
    entry_low: long ? 99 : 100, entry_high: long ? 100 : 101, entry: 100, sl: long ? 95 : 105,
    tp1: long ? 105 : 95, tp2: long ? 110 : 90, tp3: long ? 115 : 85, rr: 2.0, risk_pct: 5.0,
    confirmations: kw.confirmations || [['HTF структура', true], ['Liquidity Sweep', false]],
    narrative: 'Логика.', session: '', tf_htf: kw.tf_htf || '4H', tf_mtf: kw.tf_mtf || '1H', tf_ltf: kw.tf_ltf || '15m',
    mode_tag: '⚡ Aggressive',
  };
}

/**
 * A scanner over fakes. `plan` = {symbol: [direction, score, confirmations?]}; deliveries succeed
 * unless `fail(msg)` returns true; `atResult(params)` = the auto-trade result.
 */
function harness({ users, plan, coins = null, vol = null, fail = () => false, atResult = null, keys = {}, regime = null, extraDeps = {} }) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const log = captureLog();
  const tdb = new Database(':memory:');
  tdb.pragma('foreign_keys = OFF');
  tdb.exec(signalTradesDDL());
  tdb.exec(TRADE_EVENTS_DDL);
  const repo = createSignalTradesRepo({ db: tdb, now, log });
  const kv = memKv();
  const registry = createSignalRegistry({ kv, now, log, isAdmin: () => false, isMulti: (u) => pf.isMulti(u, { admin: false }) });
  const free = createFreeReport({ kv, now, log });
  const confluence = createSignalConfluence({ now });
  const syms = coins || Object.keys(plan);
  const volBySym = vol || Object.fromEntries(syms.map((s) => [s, 50e6]));
  const sends = [];
  const charts = [];
  const autoTrades = [];
  const saved = [];
  let inflight = 0;
  let maxInflight = 0;
  let rand = 100;
  const scanner = S.createSmcScanner({
    um: { getActiveUsers: () => users, save: (u) => saved.push({ ...u }) },
    fetcher: { volBySym, getAllUsdtPairs: async () => syms.slice(), getCandles: async () => frame() },
    cache: { getCandles: () => frame(), getCoins: () => syms.slice() },
    registry, freeReport: free, confluence, repo,
    trend: { applyMtfBonus: () => false, isCounter: () => null, cardLine: () => '', ctxRiskMult: () => 1.0 },
    freshness: { isSignalFresh: () => true, reportCycleTime() {} },
    momentumVeto: { isMomentumVeto: () => [false, ''] },
    coinQuality: { isBlacklisted: () => false },
    regime: { getCachedRegime: () => regime, regimeAllowsDirection: req('../../../services/engine/regimeLoop.js').regimeAllowsDirection },
    momentum: { isRelaxedMode: () => false },
    optimizer: { smcOptimizerFilters: () => ({ min_rr_filter: 0.0, min_q_filter: 0 }) },
    exchangeSymbols: { isAvailable: () => true, recordSkip() {} },
    access: {
      strategyEnabled: (u, s) => pf.strategyEnabled(u, s, { admin: false }),
      can: (u, f) => access.can(u, f, { admin: false }),
    },
    engine: {
      analyze: () => ({}),
      computeSqueezeScore: () => 0,
      buildSmcSignal: (symbol, _a, _cfg, kw) => {
        const p = plan[symbol];
        if (!p || !kw.allowed_dirs.includes(p[0])) return null;
        return sigFor(symbol, p[0], p[1], { confirmations: p[2], tf_htf: kw.tf_htf, tf_mtf: kw.tf_mtf, tf_ltf: kw.tf_ltf });
      },
    },
    deliver: async (msg) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setImmediate(r));
      inflight -= 1;
      const ok = !fail(msg);
      sends.push({ ...msg, ok });
      if (ok && msg.kind === 'card') repo.setSignalMsgId(msg.tradeId, sends.length, repo.cardSnapshot({ html: msg.text, actions: msg.keyboard, lang: msg.lang }));
      return ok;
    },
    deliverChart: (m) => charts.push(m),
    executeAutoTrade: atResult ? async (p) => { autoTrades.push(p); return atResult(p); } : null,
    userApiKeys: (u) => (keys[u.user_id] ? { apiKey: keys[u.user_id][0], apiSecret: keys[u.user_id][1] } : { apiKey: '', apiSecret: '' }),
    randint: () => { rand += 1; return rand; },
    sleep: async () => { await new Promise((r) => setImmediate(r)); },
    now, log, env: {}, volFilterLog: captureLog(),
    ...extraDeps,
  });
  const rows = () => tdb.prepare('SELECT * FROM signal_trades ORDER BY trade_id').all();
  const events = () => tdb.prepare('SELECT * FROM trade_events').all();
  const run = async () => { await scanner.cycleOnce(); await scanner.drainPending(); };
  return { scanner, clock, log, rows, events, sends, charts, autoTrades, saved, registry, free, kv, run, get maxInflight() { return maxInflight; } };
}

const lines = (log, needle) => log.lines.filter(([, m]) => m.includes(needle)).map(([, m]) => m);

describe('constants of smc/scanner.py', () => {
  it('TF map, semaphores, floors and TTLs', () => {
    expect(S.SMC_TF_MAP).toEqual({ '4H': ['1D', '4H', '1H'], '1H': ['4H', '1H', '15m'], '15m': ['1H', '15m', '15m'] });
    expect(S.SEND_CONCURRENCY).toBe(12);   // [SMC-CONCURRENCY-BUMP]: the bot comment says 8, the constant is 12
    expect(S.OKX_SEM_SIZE).toBe(16);
    expect([S.SMC_FLOOR, S.SMC_CAP, S.HTF_TTL_S, S.MTF_TTL_S, S.LTF_TTL_S]).toEqual([200_000, 300, 3600, 0, 0]);
    expect(S.REVERSAL_OVERRIDE_MIN).toBe(3);
    expect(S.DEFAULT_INTERVAL_S).toBe(300);
  });
});

describe('free "Pro preview" path', () => {
  it('never writes a row, never takes a registry slot, never auto-trades; quota 3/day after delivery', async () => {
    const plan = {};
    for (let i = 0; i < 5; i++) plan[`C${i}-USDT-SWAP`] = ['LONG', 4];
    const u = user(7, { sub_plan: 'free', sub_status: 'expired', sub_expires: 0, smc_short_active: false, auto_trade: true });
    const h = harness({ users: [u], plan, keys: { 7: ['k', 's'] }, atResult: () => ({ executed: true }) });
    await h.run();
    expect(h.rows()).toEqual([]);
    expect(h.registry.snapshot()).toEqual({});
    expect(h.autoTrades).toEqual([]);
    const previews = h.sends.filter((m) => m.kind === 'preview');
    expect(previews.length).toBe(3);
    expect(previews[0].text.startsWith('🎁 <b>Pro Preview</b> — SMC сигнал')).toBe(true);
    expect(previews[0].text).toContain('quality 4/10');   // QUIRK: the 0..5 score printed as /10
    expect(previews[0].silent).toBeFalsy();               // previews are never silent (no disable_notification)
    expect(u.free_smc_preview_today).toBe(3);
    expect(u.free_smc_preview_date).toBe('2025-12-29');
    expect(h.saved.length).toBe(3);
    expect(lines(h.log, '[FREE-UX] SMC preview sent').length).toBe(3);
    // next cycle the same day: the user is no longer an SMC user at all (quota spent)
    h.clock.t += 3600;
    await h.run();
    expect(h.sends.filter((m) => m.kind === 'preview').length).toBe(3);
    expect(lines(h.log, 'SMC scan:').length).toBe(1);
    // a new UTC day: the counter resets, the per-day dedup lets the same symbols through again
    h.clock.t = T0 + 86400;
    await h.run();
    expect(h.sends.filter((m) => m.kind === 'preview').length).toBe(6);
    expect(u.free_smc_preview_today).toBe(3);
  });

  it('an undelivered preview keeps the quota; the same (symbol, direction) is not sent twice a day', async () => {
    const plan = { 'A-USDT-SWAP': ['LONG', 4], 'B-USDT-SWAP': ['LONG', 3] };
    const u = user(8, { sub_plan: 'free', sub_status: 'expired', sub_expires: 0 });
    let first = true;
    const h = harness({ users: [u], plan, fail: (m) => { if (m.symbol === 'A-USDT-SWAP' && first) { first = false; return true; } return false; } });
    await h.run();
    expect(u.free_smc_preview_today).toBe(1);
    expect(lines(h.log, 'NOT delivered').length).toBe(1);
    h.clock.t += 600;
    await h.run();
    expect(u.free_smc_preview_today).toBe(2);   // A now delivered, B deduped for today
    expect(h.sends.filter((m) => m.kind === 'preview' && m.ok).map((m) => m.symbol).sort()).toEqual(['A-USDT-SWAP', 'B-USDT-SWAP']);
  });

  it('QUIRK: a free LEVELS-only user is an SMC user while the preview quota lasts', async () => {
    const u = user(9, { sub_plan: 'free', sub_status: 'expired', sub_expires: 0, strategy: 'LEVELS', long_active: true, smc_long_active: false, smc_short_active: false });
    const h = harness({ users: [u], plan: { 'A-USDT-SWAP': ['SHORT', 4] } });
    await h.run();
    expect(h.sends.map((m) => m.kind)).toEqual(['preview']);
  });

  it('quota exhausted → smart prompt hook, no send', async () => {
    const prompts = [];
    const u = user(10, { sub_plan: 'free', sub_status: 'expired', sub_expires: 0, free_smc_preview_today: 2, free_smc_preview_date: '2025-12-29' });
    const plan = { 'A-USDT-SWAP': ['LONG', 4], 'B-USDT-SWAP': ['LONG', 4] };
    const h = harness({ users: [u], plan, extraDeps: { smartPromptQuota: (uid) => prompts.push(uid) } });
    await h.run();
    expect(h.sends.length).toBe(1);
    await new Promise((r) => setImmediate(r));
    expect(prompts).toEqual([10]);
  });
});

describe('paid path: rows, delivery, registry commit', () => {
  it('row written before delivery; delivered → slot committed, signal_msg_id set; trade_events payload', async () => {
    const u = user(11);
    const h = harness({ users: [u], plan: { 'A-USDT-SWAP': ['LONG', 4] } });
    await h.run();
    const [row] = h.rows();
    expect(row.trade_id).toBe(`11_${T0 * 1000}_101`);
    expect([row.strategy, row.breakout_type, row.timeframe, row.quality, row.state, row.entry, row.entry_lo, row.entry_hi])
      .toEqual(['SMC', 'SMC', '15m', 4, 'PENDING', 100, 99, 100]);
    expect([row.tp1_rr, row.tp2_rr, row.tp3_rr]).toEqual([1, 2, 3]);
    expect(row.signal_msg_id).toBeGreaterThan(0);
    expect(row.order_link_id).toMatch(/^chm_[0-9a-f]{12}$/);
    expect(h.registry.get(11, 'A-USDT-SWAP', 'LONG', 'SMC')).toBe(T0);
    const [ev] = h.events();
    // QUIRK: the forensic payload reads getattr(sig, "is_counter_trend", False) → always false
    expect(JSON.parse(ev.payload_json)).toEqual({ strategy: 'SMC', user_id: 11, symbol: 'A-USDT-SWAP', direction: 'LONG', entry: 100, sl: 95, tp1: 105, quality: 4, tf: '15m', rr: 2, is_counter_trend: false });
    expect(ev.payload_json).toContain('"entry": 100.0');
    // the card: protect + keyboard without the «record result» button
    const card = h.sends.find((m) => m.kind === 'card');
    expect(card.protect).toBe(true);
    expect(card.keyboard.flat().map((b) => b.id)).toEqual(['chart', 'my_stats']);
  });

  it('not delivered and not traded → SKIP not_delivered, no slot; "SMC ✅" is still logged and the chart attempted', async () => {
    const u = user(12);
    const h = harness({ users: [u], plan: { 'A-USDT-SWAP': ['SHORT', 5] }, fail: (m) => m.kind === 'card' });
    await h.run();
    const [row] = h.rows();
    expect([row.result, row.state, row.skip_reason]).toEqual(['SKIP', 'FAILED', 'not_delivered']);
    expect(h.registry.get(12, 'A-USDT-SWAP', 'SHORT', 'SMC')).toBe(null);
    expect(lines(h.log, 'SMC ✅ A-USDT-SWAP SHORT').length).toBe(1);   // QUIRK
    expect(h.charts.length).toBe(1);
  });

  it('executed trade without a delivered card still commits the slot and keeps the row', async () => {
    const u = user(13, { auto_trade: true });
    const h = harness({ users: [u], plan: { 'A-USDT-SWAP': ['LONG', 4] }, keys: { 13: ['k', 's'] }, fail: (m) => m.kind === 'card', atResult: () => ({ executed: true, show_trade_btn: false, limit_msg: null }) });
    await h.run();
    expect(h.rows()[0].result).toBe('');
    expect(h.registry.get(13, 'A-USDT-SWAP', 'LONG', 'SMC')).toBe(T0);
    expect(h.autoTrades[0]).toMatchObject({ user_id: 13, entry: 99, entry_low: 99, entry_high: 100, strategy: 'SMC', quality: 4, exchange: 'bybit' });
  });

  it('registry blocks a repeat within 4 h; multi-strategy users also claim the MULTI slot', async () => {
    const u = user(14, { strategy: 'LEVELS', long_active: true, extra_strategies: 'SMC' });
    const h = harness({ users: [u], plan: { 'A-USDT-SWAP': ['LONG', 4] } });
    await h.run();
    expect(h.registry.get(14, 'A-USDT-SWAP', 'LONG', 'MULTI')).toBe(T0);
    h.clock.t += 3600;
    await h.run();
    expect(h.rows().length).toBe(1);
    h.clock.t = T0 + 4 * 3600;
    await h.run();
    expect(h.rows().length).toBe(2);
  });

  it('at most SEND_CONCURRENCY deliveries run at once', async () => {
    const plan = {};
    for (let i = 0; i < 30; i++) plan[`C${String(i).padStart(2, '0')}-USDT-SWAP`] = ['LONG', 4];
    const users = [user(15), user(16)];
    const h = harness({ users, plan, extraDeps: { sleep: async () => {} } });
    await h.run();
    expect(h.sends.length).toBe(60);
    expect(h.maxInflight).toBeLessThanOrEqual(12);
    expect(h.maxInflight).toBeGreaterThan(1);
  });
});

describe('scanner-level counter-trend gate', () => {
  const ct = (score, conf, over = {}) => {
    const u = user(20, { auto_trade: true, ...over });
    return harness({
      users: [u], plan: { 'A-USDT-SWAP': ['SHORT', score, conf] }, keys: { 20: ['k', 's'] }, regime: 'trending_up',
      atResult: () => ({ executed: false, show_trade_btn: true, limit_msg: null }),
    });
  };

  it('counter-trend with the toggle off → notice with the one-click button, no trade', async () => {
    const h = ct(5);
    await h.run();
    expect(h.autoTrades).toEqual([]);
    const notice = h.sends.find((m) => m.kind === 'notice');
    expect(notice.text).toBe('🚫 <b>Авто-трейд SMC: сделка не открыта</b>\nA SHORT\nРежим рынка: <b>trending_up</b> (контр-тренд)\n'
      + '<i>Контр-тренд выключен. Включи «Контр-тренд (A+ only)» в настройках чтобы торговать против тренда.</i>');
    expect(notice.keyboard).toEqual([[{ id: 'enable_ct_inline', label: '✅ Разрешить контр-тренд (на свой риск)', action: 'enable_ct_inline', kind: 'callback' }]]);
    expect(lines(h.log, '[FILTER-BLOCK]')[0]).toBe("[FILTER-BLOCK] uid=20 sym=A-USDT-SWAP strategy=SMC gate=counter_trend_scanner reason='regime=trending_up score=5 allow=False' value=5 threshold=4");
  });

  it('QUIRK: smc_counter_trend_min_quality 0 reads as 4 (`or 4`)', async () => {
    const h = ct(3, undefined, { allow_counter_trend: true, smc_counter_trend_min_quality: 0 });
    await h.run();
    expect(h.autoTrades).toEqual([]);
    expect(h.sends.find((m) => m.kind === 'notice').text).toContain('<i>Score сигнала 3/5 — для контр-тренда нужен ≥4/5.</i>');
  });

  it('[REVERSAL-OVERRIDE]: CHoCH + sweep lower the threshold to 3', async () => {
    const h = ct(3, [['HTF CHoCH', true], ['Liquidity Sweep', true]], { allow_counter_trend: true });
    await h.run();
    expect(lines(h.log, '[REVERSAL-OVERRIDE]')).toEqual(['[REVERSAL-OVERRIDE] uid=20 sym=A-USDT-SWAP dir=SHORT score=3 lowered min_score 4→3 (CHoCH+sweep confirmed)']);
    expect(h.autoTrades.length).toBe(1);
    // show_trade_btn → «Открыть сделку» on top of the card
    expect(h.sends.find((m) => m.kind === 'card').keyboard[0][0].id).toBe('exec_trade');
  });

  it('filters_all_off bypasses the gate', async () => {
    const h = ct(3, undefined, { filters_all_off: true });
    await h.run();
    expect(h.autoTrades.length).toBe(1);
    expect(h.sends.filter((m) => m.kind === 'notice')).toEqual([]);
  });

  it('a throwing executor is logged and treated as not executed (card still delivered)', async () => {
    const u = user(21, { auto_trade: true });
    const h = harness({ users: [u], plan: { 'A-USDT-SWAP': ['LONG', 4] }, keys: { 21: ['k', 's'] }, atResult: () => { throw new Error('exchange down'); } });
    await h.run();
    expect(lines(h.log, 'SMC auto_trade uid=21 sym=A-USDT-SWAP: exchange down').length).toBe(1);
    expect(h.sends.map((m) => m.kind)).toEqual(['card']);
  });

  it('no API keys → no gate, no executor call (the site default until auto-trade is wired)', async () => {
    const u = user(22, { auto_trade: true });
    const h = harness({ users: [u], plan: { 'A-USDT-SWAP': ['SHORT', 3] }, regime: 'trending_up', atResult: () => ({ executed: true }) });
    await h.run();
    expect(h.autoTrades).toEqual([]);
    expect(lines(h.log, 'SMC AUTO-TRADE CHECK uid=22 sym=A-USDT-SWAP: auto_trade=True mode=confirm exchange=bybit api_key=EMPTY').length).toBe(1);
  });
});

describe('per-user gates', () => {
  it('scan_interval gate stamps the last scan first; bar close clears only known users and wakes the loop', async () => {
    const a = user(30, { smc_cfg: JSON.stringify({ scan_interval: 1800 }) });
    const b = user(31, { smc_cfg: JSON.stringify({ tf_key: '4H' }) });
    const h = harness({ users: [a, b], plan: { 'A-USDT-SWAP': ['LONG', 4] } });
    await h.run();
    expect(Object.fromEntries(h.scanner._lastScan)).toEqual({ 30: T0, 31: T0 });
    h.clock.t += 600;
    await h.run();
    expect(h.scanner._lastScan.get(30)).toBe(T0);           // 600 s < 1800 s → not scanned
    expect(h.scanner._lastScan.get(31)).toBe(T0 + 600);
    const cleared = await h.scanner.onWsBarClose('BTC-USDT-SWAP', '15m');   // LTF of the 1H group
    expect(cleared).toBe(1);
    expect(h.scanner._lastScan.get(30)).toBe(0);
    expect(h.scanner.wakeEvent().isSet()).toBe(true);
    expect(await h.scanner.onWsBarClose('BTC-USDT-SWAP', '5m')).toBe(0);
  });

  it('[SMC-VOL-GATE]: first 5 blocks logged, summary every cycle', async () => {
    const plan = {};
    for (let i = 0; i < 7; i++) plan[`C${i}-USDT-SWAP`] = ['LONG', 4];
    // the universe filter takes the softest user (300 K) — the per-user gate then blocks uid 32
    const u = user(32, { smc_cfg: JSON.stringify({ min_volume_usdt: 100e6 }) });
    const h = harness({ users: [u, user(34)], plan });
    await h.run();
    expect(lines(h.log, '[SMC-VOL-GATE] ').length).toBe(5);
    expect(lines(h.log, '[SMC-VOL-GATE-SUMMARY]')).toEqual(['[SMC-VOL-GATE-SUMMARY] blocked=7 passed=7 (first 5 details above)']);
    expect(lines(h.log, '[SMC-VOL-GATE] ')[0]).toBe('[SMC-VOL-GATE] uid=32 sym=C0-USDT-SWAP coin_vol=50.00M < user_min=100.0M — skip');
  });

  it('no SMC users → the cycle returns before the profile / summary lines', async () => {
    const u = user(33, { smc_long_active: false, smc_short_active: false });
    const h = harness({ users: [u], plan: { 'A-USDT-SWAP': ['LONG', 4] } });
    await h.run();
    expect(h.log.lines).toEqual([]);
  });
});

describe('run loop', () => {
  it('cycles every interval, wakes early on the bar-close event, heartbeats, stops on abort', async () => {
    const u = user(40);
    const h = harness({ users: [u], plan: {} });
    const beats = [];
    const ac = new AbortController();
    const timers = [];
    const fakeTimers = {
      setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
      clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    };
    const registered = [];
    const loop = h.scanner.runSmcScanner({ intervalSec: 300, health: { heartbeat: (n) => beats.push(n) }, signal: ac.signal, timers: fakeTimers, registerOnBarClose: (cb) => registered.push(cb) });
    for (let i = 0; i < 20 && !timers.length; i++) await new Promise((r) => setImmediate(r));
    expect(beats).toEqual(['SMC']);
    expect(timers.map((t) => t.ms)).toEqual([300_000]);
    expect(registered.length).toBe(1);
    h.scanner.wakeEvent().set();                       // a bar close woke it
    for (let i = 0; i < 20 && beats.length < 2; i++) await new Promise((r) => setImmediate(r));
    expect(beats).toEqual(['SMC', 'SMC']);
    ac.abort();
    await loop;
    expect(lines(h.log, 'SMC Scanner stopped.').length).toBe(1);
    expect(lines(h.log, 'SMC Scanner started, interval=300s').length).toBe(1);
  });
});
