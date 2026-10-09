'use strict';
/**
 * Fake exchange servers for the end-to-end auto-trade tests (no network): Bybit v5, BingX swap v2,
 * Binance USDⓈ-M and OKX v5 behind one transport the trader runtimes use. Each one is a small
 * stateful matching engine per account (API key): balances, leverage, positions (hedge sides; Bybit
 * one-way), resting limit / conditional orders, attached SL / TP, cancel / close — and it answers in
 * the shapes the exchanges document (the ones the trader parity suites replay).
 *
 * Every signed request is authenticated like the exchange does it: the account is looked up by the
 * API-key header and the signature is checked with that account's secret (Bybit X-BAPI-SIGN over
 * ts + key + recvWindow + query|body, BingX / Binance HMAC of the query before `&signature=`, OKX
 * base64 HMAC of ts + method + path?query + body, plus the OKX passphrase). A bad key / signature gets
 * the exchange's auth error, so a request signed with the wrong secret never "works" here.
 *
 * Fills: a market order fills at the last price; a limit order fills at its price when it is
 * marketable, else rests; conditional (stop / take-profit) orders and reduce-only limits rest. A
 * reduce-only order needs a position on the side it reduces (else the exchange's reduce-only error:
 * Bybit 110017, BingX 101205, Binance -2022, OKX 51169) — so a close sent with the wrong side does not
 * close anything, as on the real exchanges. A position closed to zero drops that side's reduce-only /
 * conditional orders (a modelling choice — the E2E asserts positions after a close, not leftovers).
 *
 * Leniency — the requests a live exchange might refuse are served AND recorded in `lenient`
 * ({ex, path, what}) so a test pins exactly which bot requests rely on it:
 *   BingX  an order without positionSide takes LONG (BingX docs: "defaults to LONG if empty");
 *          a mixed-case side ('Sell') is upper-cased
 *   OKX    an order without posSide on the long/short account takes the side its reduce direction
 *          implies (OKX docs: posSide is required in long/short mode); a px off the tick is kept
 *
 *   createFakeExchanges({clock, instruments, prices}) → {
 *     transport(req) → {status, headers, text}    the runtime transport (rt.transport)
 *     addAccount(ex, {key, secret, passphrase, balance, perms}) / account(ex, key)
 *     positions(ex, key) / orders(ex, key)          live state (coins, native symbols)
 *     requests, unhandled, lenient                   every request seen / the ones no route served /
 *                                                    the ones served leniently (see above)
 *     setPrice(base, price)
 *   }
 */

const { bybitSign } = require('../../../services/exchanges/bybitHttp');
const { binanceSign } = require('../../../services/exchanges/binanceTrader');
const { okxSign } = require('../../../services/exchanges/okxTrader');
const crypto = require('crypto');

const JSON_HDR = { 'content-type': 'application/json' };
const resp = (obj, status = 200) => ({ status, headers: { ...JSON_HDR }, text: JSON.stringify(obj) });

function parseQuery(qs) {
  const out = {};
  if (!qs) return out;
  for (const part of qs.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, ' '));
    const v = i < 0 ? '' : decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

const fmt = (x, dp = 8) => {
  const s = Number(x).toFixed(dp);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

function createFakeExchanges({ clock, instruments = {}, prices = {} } = {}) {
  const now = () => (clock ? clock.now() : Date.now() / 1000);
  const accounts = new Map();      // `${ex}|${key}` → account
  const requests = [];
  const lenient = [];
  const lenientNote = (ex, path, what) => { lenient.push({ ex, path, what }); };
  const unhandled = [];
  const px = { ...prices };        // base → last price
  let nextId = 7000;
  const newId = () => { nextId += 1; return nextId; };

  // ── symbols ──
  const baseOf = (ex, native) => {
    const s = String(native || '').toUpperCase();
    if (ex === 'okx') return s.replace(/-USDT-SWAP$/, '');
    if (ex === 'bingx') return s.replace(/-USDT$/, '');
    return s.replace(/USDT$/, '');
  };
  const nativeOf = (ex, base) => (ex === 'okx' ? `${base}-USDT-SWAP` : (ex === 'bingx' ? `${base}-USDT` : `${base}USDT`));
  const inst = (base) => instruments[base] || null;
  const priceOf = (base) => (px[base] === undefined ? null : px[base]);

  function addAccount(ex, { key, secret, passphrase = '', balance = 10000, perms = null } = {}) {
    const a = {
      ex, key, secret, passphrase, balance, perms,
      leverage: new Map(), hedge: ex !== 'bybit', positions: new Map(), orders: [], closedPnl: [],
    };
    accounts.set(`${ex}|${key}`, a);
    return a;
  }
  const account = (ex, key) => accounts.get(`${ex}|${key}`) || null;

  // ── positions: Map base → {LONG: pos|null, SHORT: pos|null}; pos = {size, entry, sl, tp, lev} ──
  function posOf(a, base, side) {
    const p = a.positions.get(base);
    return p && p[side] && p[side].size > 0 ? p[side] : null;
  }
  function open(a, base, side, qty, price) {
    if (!a.positions.has(base)) a.positions.set(base, { LONG: null, SHORT: null });
    const p = a.positions.get(base);
    const cur = p[side];
    if (cur && cur.size > 0) {
      const size = cur.size + qty;
      cur.entry = (cur.entry * cur.size + price * qty) / size;
      cur.size = size;
    } else {
      p[side] = { size: qty, entry: price, sl: 0, tp: 0, lev: a.leverage.get(base) || 10 };
    }
    return p[side];
  }
  function reduce(a, base, side, qty) {
    const cur = posOf(a, base, side);
    if (!cur) return 0;
    const q = Math.min(qty, cur.size);
    cur.size = Number((cur.size - q).toFixed(10));
    const last = priceOf(base) || cur.entry;
    a.closedPnl.push({ base, side, qty: q, entry: cur.entry, exit: last, ts: now() });
    if (cur.size <= 1e-12) {
      a.positions.get(base)[side] = null;
      // the exchange drops a closed position's attached / reduce-only orders
      a.orders = a.orders.filter((o) => !(o.base === base && o.posSide === side && (o.reduceOnly || o.cond)));
    }
    return q;
  }
  function allPositions(a) {
    const out = [];
    for (const [base, p] of a.positions) for (const side of ['LONG', 'SHORT']) if (p[side] && p[side].size > 0) out.push({ base, side, ...p[side] });
    return out;
  }
  const opposite = (side) => (side === 'LONG' ? 'SHORT' : 'LONG');

  /** One order on `a`: {base, side BUY|SELL, posSide LONG|SHORT, type MARKET|LIMIT|STOP|TP, qty, price, trigger, reduceOnly}. */
  function place(a, o) {
    const last = priceOf(o.base);
    const id = newId();
    const reducing = o.reduceOnly || (o.side === 'SELL' && o.posSide === 'LONG') || (o.side === 'BUY' && o.posSide === 'SHORT');
    if (o.type === 'STOP' || o.type === 'TP') {
      a.orders.push({ id, ...o, cond: true, reduceOnly: true, ts: now() });
      return { ok: true, id, filled: false };
    }
    if (reducing) {
      if (!posOf(a, o.base, o.posSide)) return { ok: false, reason: 'reduce_only' };
      if (o.type === 'LIMIT') {
        const crosses = o.side === 'SELL' ? o.price <= last : o.price >= last;
        if (!crosses) {
          a.orders.push({ id, ...o, cond: false, reduceOnly: true, ts: now() });
          return { ok: true, id, filled: false };
        }
      }
      const q = reduce(a, o.base, o.posSide, o.qty);
      return { ok: true, id, filled: true, qty: q, avg: last };
    }
    if (o.type === 'LIMIT') {
      const crosses = o.side === 'BUY' ? o.price >= last : o.price <= last;
      if (!crosses) {
        a.orders.push({ id, ...o, cond: false, reduceOnly: false, ts: now() });
        return { ok: true, id, filled: false };
      }
      open(a, o.base, o.posSide, o.qty, o.price);
      return { ok: true, id, filled: true, qty: o.qty, avg: o.price };
    }
    open(a, o.base, o.posSide, o.qty, last);
    return { ok: true, id, filled: true, qty: o.qty, avg: last };
  }
  const cancelAll = (a, base) => {
    const n = a.orders.filter((o) => o.base === base).length;
    a.orders = a.orders.filter((o) => o.base !== base);
    return n;
  };

  // ══════════════════════════ Bybit v5 ══════════════════════════
  function bybit(method, path, query, body, headers, rawQs, rawBody) {
    const ok = (result) => resp({ retCode: 0, retMsg: 'OK', result, retExtInfo: {}, time: Math.trunc(now() * 1000) });
    const err = (code, msg) => resp({ retCode: code, retMsg: msg, result: {}, retExtInfo: {}, time: Math.trunc(now() * 1000) });
    if (path === '/v5/market/time') return ok({ timeSecond: String(Math.trunc(now())), timeNano: `${Math.trunc(now())}000000000` });
    if (path === '/v5/market/instruments-info') {
      const base = baseOf('bybit', query.symbol);
      const i = inst(base);
      if (!i) return ok({ category: 'linear', list: [] });
      return ok({
        category: 'linear',
        list: [{
          symbol: query.symbol, status: 'Trading', contractType: 'LinearPerpetual',
          lotSizeFilter: { qtyStep: fmt(i.step), minOrderQty: fmt(i.minQty || i.step), maxOrderQty: '1000000', minNotionalValue: '5' },
          priceFilter: { tickSize: fmt(i.tick) }, leverageFilter: { minLeverage: '1', maxLeverage: String(i.maxLev || 100), leverageStep: '0.01' },
        }],
      });
    }
    if (path === '/v5/market/tickers') {
      const base = baseOf('bybit', query.symbol);
      const p = priceOf(base);
      if (p === null) return ok({ category: 'linear', list: [] });
      const i = inst(base) || { tick: 0.01 };
      return ok({
        category: 'linear',
        list: [{ symbol: query.symbol, lastPrice: fmt(p), markPrice: fmt(p), bid1Price: fmt(p - i.tick), ask1Price: fmt(p + i.tick), fundingRate: '0.0001' }],
      });
    }
    // authenticated from here
    const key = headers['X-BAPI-API-KEY'];
    const a = account('bybit', key);
    if (!a) return err(10003, 'API key is invalid.');
    const payload = method === 'GET' ? rawQs : rawBody;
    const want = bybitSign(a.secret, String(headers['X-BAPI-TIMESTAMP']) + key + String(headers['X-BAPI-RECV-WINDOW']) + (payload || ''));
    if (want !== headers['X-BAPI-SIGN']) return err(10004, 'error sign! origin_string[...]');
    const posRow = (base, side, p) => ({
      symbol: nativeOf('bybit', base), side: side === 'LONG' ? 'Buy' : 'Sell', size: fmt(p.size), positionIdx: 0,
      avgPrice: fmt(p.entry), markPrice: fmt(priceOf(base) || p.entry), stopLoss: p.sl ? fmt(p.sl) : '', takeProfit: p.tp ? fmt(p.tp) : '',
      leverage: String(p.lev), unrealisedPnl: fmt(((priceOf(base) || p.entry) - p.entry) * p.size * (side === 'LONG' ? 1 : -1)),
      positionValue: fmt(p.size * p.entry), tradeMode: 0, positionStatus: 'Normal',
    });
    switch (path) {
      case '/v5/user/query-api':
        return ok({ apiKey: key, readOnly: 0, permissions: a.perms || { ContractTrade: ['Order', 'Position'], Spot: [], Wallet: ['AccountTransfer'], Options: [], Derivatives: [], Exchange: [], NFT: [], Affiliate: [] } });
      case '/v5/account/wallet-balance':
        return ok({ list: [{ accountType: 'UNIFIED', totalEquity: fmt(a.balance), totalAvailableBalance: fmt(a.balance), totalWalletBalance: fmt(a.balance), totalUnrealisedPnl: '0', coin: [{ coin: 'USDT', walletBalance: fmt(a.balance), equity: fmt(a.balance), availableToWithdraw: '', availableBalance: '' }] }] });
      case '/v5/position/switch-isolated':
        return err(110026, 'Cross/isolated margin mode is not modified');
      case '/v5/position/set-leverage': {
        const base = baseOf('bybit', body.symbol);
        if (a.leverage.get(base) === Number(body.buyLeverage)) return err(110043, 'leverage not modified');
        a.leverage.set(base, Number(body.buyLeverage));
        return ok({});
      }
      case '/v5/position/list': {
        const list = [];
        for (const p of allPositions(a)) if (!query.symbol || nativeOf('bybit', p.base) === query.symbol) list.push(posRow(p.base, p.side, p));
        if (query.symbol && !list.length) list.push({ symbol: query.symbol, side: '', size: '0', positionIdx: 0, avgPrice: '0', markPrice: fmt(priceOf(baseOf('bybit', query.symbol)) || 0), stopLoss: '', takeProfit: '', leverage: '10', unrealisedPnl: '0' });
        return ok({ category: 'linear', list });
      }
      case '/v5/order/create': {
        const base = baseOf('bybit', body.symbol);
        if (!inst(base)) return err(10001, 'params error: symbol invalid');
        const side = body.side === 'Buy' ? 'BUY' : 'SELL';
        // one-way mode: a Sell reduces a long, a Buy reduces a short
        let posSide = side === 'BUY' ? 'LONG' : 'SHORT';
        if (body.reduceOnly) posSide = side === 'BUY' ? 'SHORT' : 'LONG';
        const r = place(a, {
          base, side, posSide, type: body.orderType === 'Market' ? 'MARKET' : 'LIMIT', qty: Number(body.qty),
          price: body.price === undefined ? 0 : Number(body.price), reduceOnly: Boolean(body.reduceOnly), clientId: body.orderLinkId || '',
        });
        if (!r.ok) return err(110017, 'current position is zero, cannot fix reduce-only order qty');
        if (r.filled && !body.reduceOnly) {
          const p = posOf(a, base, posSide);
          if (body.stopLoss) p.sl = Number(body.stopLoss);
          if (body.takeProfit) p.tp = Number(body.takeProfit);
        }
        return ok({ orderId: `by-${r.id}`, orderLinkId: body.orderLinkId || '' });
      }
      case '/v5/position/trading-stop': {
        const base = baseOf('bybit', body.symbol);
        const p = posOf(a, base, 'LONG') || posOf(a, base, 'SHORT');
        if (!p) return err(10001, 'can not set tp/sl/ts for zero position');
        if (body.stopLoss !== undefined) p.sl = Number(body.stopLoss) || 0;
        if (body.takeProfit !== undefined) p.tp = Number(body.takeProfit) || 0;
        return ok({});
      }
      case '/v5/order/realtime': {
        const list = a.orders.filter((o) => !query.symbol || nativeOf('bybit', o.base) === query.symbol).map((o) => ({
          orderId: `by-${o.id}`, orderLinkId: o.clientId || '', symbol: nativeOf('bybit', o.base), side: o.side === 'BUY' ? 'Buy' : 'Sell',
          orderType: o.type === 'MARKET' ? 'Market' : 'Limit', price: fmt(o.price || 0), qty: fmt(o.qty), reduceOnly: Boolean(o.reduceOnly),
          orderStatus: o.cond ? 'Untriggered' : 'New', triggerPrice: o.trigger ? fmt(o.trigger) : '', stopOrderType: '', createdTime: String(Math.trunc(o.ts * 1000)),
        }));
        return ok({ category: 'linear', list, nextPageCursor: '' });
      }
      case '/v5/order/cancel-all': {
        const base = baseOf('bybit', body.symbol);
        const gone = a.orders.filter((o) => o.base === base).map((o) => ({ orderId: `by-${o.id}`, orderLinkId: o.clientId || '' }));
        cancelAll(a, base);
        return ok({ list: gone, success: '1' });
      }
      case '/v5/order/cancel': {
        const n = a.orders.length;
        a.orders = a.orders.filter((o) => `by-${o.id}` !== body.orderId);
        return n === a.orders.length ? err(110001, 'order not exists or too late to cancel') : ok({ orderId: body.orderId });
      }
      case '/v5/position/closed-pnl':
      case '/v5/execution/list':
        return ok({ category: 'linear', list: [], nextPageCursor: '' });
      default:
        return null;
    }
  }

  // ══════════════════════════ BingX swap v2 ══════════════════════════
  function bingx(method, path, query, headers, rawQs) {
    const ok = (data) => resp({ code: 0, msg: '', data });
    const err = (code, msg) => resp({ code, msg, data: {} });
    if (path === '/openApi/swap/v2/quote/contracts') {
      return ok(Object.entries(instruments).map(([base, i]) => ({
        symbol: nativeOf('bingx', base), tradeMinQuantity: i.step, quantityPrecision: Math.max(0, -Math.round(Math.log10(i.step))),
        pricePrecision: Math.max(0, -Math.round(Math.log10(i.tick))), maxLeverage: i.maxLev || 100, status: 1, currency: 'USDT', asset: base,
      })));
    }
    if (path === '/openApi/server/v1/time') return ok({ serverTime: Math.trunc(now() * 1000) });
    const key = headers['X-BX-APIKEY'];
    const a = account('bingx', key);
    if (!a) return err(100413, 'Incorrect apiKey');
    const unsigned = rawQs.split('&signature=')[0];
    const sig = rawQs.includes('&signature=') ? rawQs.split('&signature=')[1] : '';
    const want = crypto.createHmac('sha256', Buffer.from(a.secret, 'utf8')).update(Buffer.from(unsigned, 'utf8')).digest('hex');
    if (want !== sig) return err(100001, 'Signature verification failed');
    const posRow = (p) => ({
      symbol: nativeOf('bingx', p.base), positionSide: p.side, positionAmt: fmt(p.size), avgPrice: fmt(p.entry), markPrice: fmt(priceOf(p.base) || p.entry),
      unrealizedProfit: fmt(((priceOf(p.base) || p.entry) - p.entry) * p.size * (p.side === 'LONG' ? 1 : -1)), leverage: p.lev, stopLoss: p.sl ? fmt(p.sl) : '',
    });
    const ordRow = (o) => ({
      orderId: o.id, symbol: nativeOf('bingx', o.base), side: o.side, positionSide: o.posSide,
      type: o.type === 'STOP' ? 'STOP_MARKET' : (o.type === 'TP' ? 'TAKE_PROFIT_MARKET' : o.type), price: fmt(o.price || 0), origQty: fmt(o.qty),
      stopPrice: fmt(o.trigger || 0), clientOrderId: o.clientId || '', status: 'NEW', time: Math.trunc(o.ts * 1000),
    });
    switch (path) {
      case '/openApi/v1/account/apiPermissions':
        return ok({ ipAddresses: [], note: 'autotrade', permissions: a.perms || [1, 2, 3] });
      case '/openApi/swap/v2/user/balance':
        return ok({ balance: { userId: '1', asset: 'USDT', balance: fmt(a.balance), equity: fmt(a.balance), unrealizedProfit: '0', availableMargin: fmt(a.balance) } });
      case '/openApi/swap/v1/user/balance':
        return ok([{ balance: fmt(a.balance) }]);
      case '/openApi/swap/v2/quote/price': {
        const p = priceOf(baseOf('bingx', query.symbol));
        return p === null ? err(109400, 'symbol not exist') : ok({ symbol: query.symbol, price: fmt(p), time: Math.trunc(now() * 1000) });
      }
      case '/openApi/swap/v2/trade/leverage':
        a.leverage.set(baseOf('bingx', query.symbol), Number(query.leverage));
        return ok({ leverage: Number(query.leverage), symbol: query.symbol });
      case '/openApi/swap/v2/trade/batchOrders':
        // BingX's batch endpoint rejects these batches in production (the bot's legacy path exists for it)
        return err(100001, 'Signature verification failed');
      case '/openApi/swap/v2/trade/order': {
        if (method === 'DELETE') {
          const n = a.orders.length;
          a.orders = a.orders.filter((o) => String(o.id) !== String(query.orderId));
          return n === a.orders.length ? err(109400, 'order not exist') : ok({ order: { orderId: Number(query.orderId) } });
        }
        const base = baseOf('bingx', query.symbol);
        if (!inst(base)) return err(109400, 'symbol not exist');
        let side = query.side;
        if (side !== String(side).toUpperCase()) { lenientNote('bingx', path, `side ${side}`); side = String(side).toUpperCase(); }
        const type = query.type === 'STOP_MARKET' ? 'STOP' : (query.type === 'TAKE_PROFIT_MARKET' || query.type === 'TAKE_PROFIT' ? 'TP' : query.type);
        let posSide = query.positionSide;
        if (!posSide) { lenientNote('bingx', path, `no positionSide (${query.type})`); posSide = 'LONG'; }
        if (!['LONG', 'SHORT'].includes(posSide)) return err(109400, 'positionSide error');
        const r = place(a, {
          base, side, posSide, type, qty: Number(query.quantity), price: query.price === undefined ? 0 : Number(query.price),
          trigger: query.stopPrice === undefined ? 0 : Number(query.stopPrice), reduceOnly: query.reduceOnly === 'true', clientId: query.clientOrderId || '',
        });
        if (!r.ok) return err(101205, 'No position to close');
        return ok({ order: { orderId: r.id, symbol: query.symbol, side, positionSide: posSide, type: query.type, clientOrderId: query.clientOrderId || '' } });
      }
      case '/openApi/swap/v2/user/positions':
        return ok(allPositions(a).filter((p) => !query.symbol || nativeOf('bingx', p.base) === query.symbol).map(posRow));
      case '/openApi/swap/v2/trade/openOrders':
        return ok({ orders: a.orders.filter((o) => !query.symbol || nativeOf('bingx', o.base) === query.symbol).map(ordRow) });
      case '/openApi/swap/v2/trade/allOpenOrders': {
        const base = baseOf('bingx', query.symbol);
        const gone = a.orders.filter((o) => o.base === base).map((o) => ({ orderId: o.id }));
        cancelAll(a, base);
        return ok({ success: gone, orders: gone });
      }
      case '/openApi/swap/v2/trade/allFillOrders':
        return ok({ fill_orders: [] });
      case '/openApi/swap/v2/trade/allOrders':
        return ok({ orders: [] });
      default:
        return null;
    }
  }

  // ══════════════════════════ Binance USDⓈ-M ══════════════════════════
  function binance(method, path, query, headers, rawQs, host) {
    const err = (code, msg, status = 400) => resp({ code, msg }, status);
    if (path === '/fapi/v1/ping') return resp({});
    if (path === '/fapi/v1/time') return resp({ serverTime: Math.trunc(now() * 1000) });
    if (path === '/fapi/v1/exchangeInfo') {
      return resp({
        timezone: 'UTC', serverTime: Math.trunc(now() * 1000),
        symbols: Object.entries(instruments).map(([base, i]) => ({
          symbol: nativeOf('binance', base), status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT',
          filters: [
            { filterType: 'PRICE_FILTER', tickSize: fmt(i.tick), minPrice: fmt(i.tick), maxPrice: '10000000' },
            { filterType: 'LOT_SIZE', stepSize: fmt(i.step), minQty: fmt(i.minQty || i.step), maxQty: '1000000' },
            { filterType: 'MARKET_LOT_SIZE', stepSize: fmt(i.step), minQty: fmt(i.minQty || i.step), maxQty: '1000000' },
            { filterType: 'MIN_NOTIONAL', notional: '5' },
          ],
        })),
      });
    }
    if (path === '/fapi/v1/ticker/price') {
      const p = priceOf(baseOf('binance', query.symbol));
      return p === null ? err(-1121, 'Invalid symbol.') : resp({ symbol: query.symbol, price: fmt(p), time: Math.trunc(now() * 1000) });
    }
    const key = headers['X-MBX-APIKEY'];
    const a = account('binance', key);
    if (!a) return err(-2015, 'Invalid API-key, IP, or permissions for action.', 401);
    const unsigned = rawQs.split('&signature=')[0];
    const sig = rawQs.includes('&signature=') ? rawQs.split('&signature=')[1] : '';
    if (binanceSign(unsigned, a.secret) !== sig) return err(-1022, 'Signature for this request is not valid.');
    if (host === 'api.binance.com') {
      if (path === '/sapi/v1/account/apiRestrictions') {
        return resp({ ipRestrict: false, createTime: 1767000000000, enableReading: true, enableWithdrawals: Boolean(a.perms && a.perms.withdraw), enableInternalTransfer: false, enableMargin: false, enableFutures: true, permitsUniversalTransfer: false, enableVanillaOptions: false, enableSpotAndMarginTrading: false });
      }
      return null;
    }
    const posRows = (sym) => {
      const out = [];
      for (const base of new Set([...Object.keys(instruments)])) {
        const native = nativeOf('binance', base);
        if (sym && native !== sym) continue;
        for (const side of ['LONG', 'SHORT']) {
          const p = posOf(a, base, side);
          if (!p && !sym) continue;
          out.push({
            symbol: native, positionSide: side, positionAmt: p ? fmt(side === 'LONG' ? p.size : -p.size) : '0.000', entryPrice: p ? fmt(p.entry) : '0.0',
            markPrice: fmt(priceOf(base) || 0), unRealizedProfit: p ? fmt(((priceOf(base) || p.entry) - p.entry) * p.size * (side === 'LONG' ? 1 : -1)) : '0.0',
            liquidationPrice: '0', leverage: String(a.leverage.get(base) || 10), marginType: 'cross',
          });
        }
      }
      return out;
    };
    const ordRow = (o) => ({
      orderId: o.id, symbol: nativeOf('binance', o.base), status: 'NEW', clientOrderId: o.clientId || '', price: fmt(o.price || 0), avgPrice: '0', origQty: fmt(o.qty),
      executedQty: '0', type: o.type === 'STOP' ? 'STOP_MARKET' : (o.type === 'TP' ? 'TAKE_PROFIT_MARKET' : o.type), side: o.side, positionSide: o.posSide,
      stopPrice: fmt(o.trigger || 0), reduceOnly: Boolean(o.reduceOnly), closePosition: false, time: Math.trunc(o.ts * 1000), updateTime: Math.trunc(o.ts * 1000),
    });
    const one = (q) => {
      const base = baseOf('binance', q.symbol);
      if (!inst(base)) return { code: -1121, msg: 'Invalid symbol.' };
      const type = q.type === 'STOP_MARKET' ? 'STOP' : (q.type === 'TAKE_PROFIT_MARKET' ? 'TP' : q.type);
      const posSide = q.positionSide || (q.side === 'BUY' ? 'LONG' : 'SHORT');
      const r = place(a, {
        base, side: q.side, posSide, type, qty: Number(q.quantity), price: q.price === undefined ? 0 : Number(q.price),
        trigger: q.stopPrice === undefined ? 0 : Number(q.stopPrice), reduceOnly: q.reduceOnly === 'true' || q.reduceOnly === true, clientId: q.newClientOrderId || '',
      });
      if (!r.ok) return { code: -2022, msg: 'ReduceOnly Order is rejected.' };
      return {
        orderId: r.id, symbol: q.symbol, status: r.filled ? 'FILLED' : 'NEW', clientOrderId: q.newClientOrderId || '', price: fmt(q.price || 0),
        avgPrice: r.filled ? fmt(r.avg) : '0.00000', origQty: String(q.quantity), executedQty: r.filled ? String(q.quantity) : '0', type: q.type, side: q.side, positionSide: posSide,
      };
    };
    switch (path) {
      case '/fapi/v2/balance':
        return resp([{ accountAlias: 'Fk', asset: 'USDT', balance: fmt(a.balance), crossWalletBalance: fmt(a.balance), crossUnPnl: '0.0', availableBalance: fmt(a.balance), maxWithdrawAmount: fmt(a.balance) }]);
      case '/fapi/v1/positionSide/dual':
        if (a.hedge) return err(-4059, 'No need to change position side.');
        a.hedge = true;
        return resp({ code: 200, msg: 'success' });
      case '/fapi/v1/leverage':
        a.leverage.set(baseOf('binance', query.symbol), Number(query.leverage));
        return resp({ leverage: Number(query.leverage), maxNotionalValue: '1000000', symbol: query.symbol });
      case '/fapi/v1/batchOrders': {
        const list = JSON.parse(query.batchOrders);
        return resp(list.map((q) => one(q)));
      }
      case '/fapi/v1/order': {
        if (method === 'DELETE') {
          const n = a.orders.length;
          a.orders = a.orders.filter((o) => String(o.id) !== String(query.orderId));
          return n === a.orders.length ? err(-2011, 'Unknown order sent.') : resp({ orderId: Number(query.orderId), status: 'CANCELED' });
        }
        const r = one(query);
        return r.code !== undefined && r.code < 0 ? err(r.code, r.msg) : resp(r);
      }
      case '/fapi/v2/positionRisk':
        return resp(posRows(query.symbol || null));
      case '/fapi/v1/openOrders':
        return resp(a.orders.filter((o) => !query.symbol || nativeOf('binance', o.base) === query.symbol).map(ordRow));
      case '/fapi/v1/allOpenOrders':
        cancelAll(a, baseOf('binance', query.symbol));
        return resp({ code: 200, msg: 'The operation of cancel all open order is done.' });
      case '/fapi/v1/income':
      case '/fapi/v1/userTrades':
        return resp([]);
      default:
        return null;
    }
  }

  // ══════════════════════════ OKX v5 ══════════════════════════
  function okx(method, path, query, body, headers, pathWithQs, rawBody) {
    const ok = (data) => resp({ code: '0', msg: '', data });
    const err = (code, msg, data = []) => resp({ code: String(code), msg, data });
    if (path === '/api/v5/public/time') return ok([{ ts: String(Math.trunc(now() * 1000)) }]);
    if (path === '/api/v5/public/instruments') {
      const list = Object.entries(instruments).filter(([base]) => !query.instId || nativeOf('okx', base) === query.instId).map(([base, i]) => ({
        instType: 'SWAP', instId: nativeOf('okx', base), ctType: 'linear', ctValCcy: base, ctVal: fmt(i.ctVal), lotSz: fmt(i.lotSz || 1), tickSz: fmt(i.tick),
        minSz: fmt(i.lotSz || 1), lever: String(i.maxLev || 100), state: 'live', settleCcy: 'USDT',
      }));
      return ok(list);
    }
    if (path === '/api/v5/market/ticker') {
      const p = priceOf(baseOf('okx', query.instId));
      return p === null ? err(51001, "Instrument ID doesn't exist.") : ok([{ instId: query.instId, last: fmt(p), bidPx: fmt(p), askPx: fmt(p) }]);
    }
    const key = headers['OK-ACCESS-KEY'];
    const a = account('okx', key);
    if (!a) return err(50111, 'Invalid OK-ACCESS-KEY');
    if (headers['OK-ACCESS-PASSPHRASE'] !== a.passphrase) return err(50105, 'Your OK-ACCESS-PASSPHRASE is incorrect.');
    if (okxSign(headers['OK-ACCESS-TIMESTAMP'], method, pathWithQs, rawBody || '', a.secret) !== headers['OK-ACCESS-SIGN']) return err(50113, 'Invalid Sign');
    const ctv = (base) => (inst(base) ? inst(base).ctVal : 1);
    const posRow = (p) => ({
      instId: nativeOf('okx', p.base), posSide: p.side.toLowerCase(), pos: fmt(p.size / ctv(p.base)), avgPx: fmt(p.entry), markPx: fmt(priceOf(p.base) || p.entry),
      upl: fmt(((priceOf(p.base) || p.entry) - p.entry) * p.size * (p.side === 'LONG' ? 1 : -1)), lever: String(a.leverage.get(p.base) || 10), liqPx: '', mgnMode: 'cross',
    });
    const orderFrom = (b, cond) => {
      const base = baseOf('okx', b.instId);
      const side = String(b.side).toUpperCase();
      let posSide = b.posSide ? String(b.posSide).toUpperCase() : null;
      const reducing = Boolean(b.reduceOnly) || cond;
      if (!posSide) {
        lenientNote('okx', cond ? '/api/v5/trade/order-algo' : '/api/v5/trade/order', `no posSide (${b.ordType || 'algo'}${reducing ? ', reduceOnly' : ''})`);
        posSide = reducing ? (side === 'SELL' ? 'LONG' : 'SHORT') : (side === 'BUY' ? 'LONG' : 'SHORT');
      }
      const tick = inst(base) ? inst(base).tick : 0;
      if (b.px !== undefined && tick > 0 && Math.abs(Number(b.px) / tick - Math.round(Number(b.px) / tick)) > 1e-6) lenientNote('okx', '/api/v5/trade/order', `px ${b.px} off tick ${tick}`);
      return { base, side, posSide, qty: Number(b.sz) * ctv(base), reduceOnly: reducing };
    };
    switch (path) {
      case '/api/v5/account/config':
        return ok([{ uid: '1', acctLv: '2', posMode: 'long_short_mode', perm: a.perms || 'read_only,trade', label: 'autotrade' }]);
      case '/api/v5/account/balance':
        return ok([{ totalEq: fmt(a.balance), upl: '0', details: [{ ccy: 'USDT', eq: fmt(a.balance), cashBal: fmt(a.balance), availBal: fmt(a.balance), availEq: fmt(a.balance) }] }]);
      case '/api/v5/account/set-leverage':
        a.leverage.set(baseOf('okx', body.instId), Number(body.lever));
        return ok([{ instId: body.instId, lever: String(body.lever), mgnMode: body.mgnMode || 'cross', posSide: '' }]);
      case '/api/v5/trade/order': {
        const o = orderFrom(body, false);
        if (!inst(o.base)) return err(51001, "Instrument ID doesn't exist.");
        const r = place(a, { ...o, type: body.ordType === 'market' ? 'MARKET' : 'LIMIT', price: body.px === undefined ? 0 : Number(body.px) });
        if (!r.ok) return err(1, 'All operations failed', [{ ordId: '', sCode: '51169', sMsg: "Order failed because you don't have any positions in this direction for this contract to reduce or close." }]);
        if (r.filled && !o.reduceOnly) {
          for (const att of body.attachAlgoOrds || []) {
            const closeSide = o.side === 'BUY' ? 'SELL' : 'BUY';
            const sz = att.sz === undefined ? o.qty : Number(att.sz) * ctv(o.base);
            if (att.slTriggerPx) a.orders.push({ id: newId(), base: o.base, side: closeSide, posSide: o.posSide, type: 'STOP', qty: sz, trigger: Number(att.slTriggerPx), reduceOnly: true, cond: true, algo: true, ts: now() });
            if (att.tpTriggerPx) a.orders.push({ id: newId(), base: o.base, side: closeSide, posSide: o.posSide, type: 'TP', qty: sz, trigger: Number(att.tpTriggerPx), reduceOnly: true, cond: true, algo: true, ts: now() });
          }
        }
        return ok([{ ordId: String(r.id), clOrdId: body.clOrdId || '', tag: '', sCode: '0', sMsg: 'Order placed' }]);
      }
      case '/api/v5/trade/order-algo': {
        const o = orderFrom(body, true);
        if (!posOf(a, o.base, o.posSide)) return err(1, 'Operation failed', [{ algoId: '', sCode: '51169', sMsg: 'no position' }]);
        const id = newId();
        a.orders.push({ id, base: o.base, side: o.side, posSide: o.posSide, type: body.slTriggerPx ? 'STOP' : 'TP', qty: o.qty, trigger: Number(body.slTriggerPx || body.tpTriggerPx), reduceOnly: true, cond: true, algo: true, ts: now() });
        return ok([{ algoId: String(id), sCode: '0', sMsg: '' }]);
      }
      case '/api/v5/account/positions':
        return ok(allPositions(a).filter((p) => !query.instId || nativeOf('okx', p.base) === query.instId).map(posRow));
      case '/api/v5/trade/close-position': {
        const base = baseOf('okx', body.instId);
        const side = String(body.posSide || '').toUpperCase();
        if (!['LONG', 'SHORT'].includes(side) || !posOf(a, base, side)) return err(51023, 'Position does not exist');
        reduce(a, base, side, posOf(a, base, side).size);
        return ok([{ instId: body.instId, posSide: body.posSide }]);
      }
      case '/api/v5/trade/orders-pending':
        return ok(a.orders.filter((o) => !o.algo).map((o) => ({ ordId: String(o.id), instId: nativeOf('okx', o.base), side: o.side.toLowerCase(), posSide: o.posSide.toLowerCase(), ordType: o.type === 'MARKET' ? 'market' : 'limit', px: fmt(o.price || 0), sz: fmt(o.qty / ctv(o.base)), reduceOnly: String(Boolean(o.reduceOnly)), cTime: String(Math.trunc(o.ts * 1000)) })));
      case '/api/v5/trade/cancel-order': {
        const n = a.orders.length;
        a.orders = a.orders.filter((o) => String(o.id) !== String(body.ordId));
        return n === a.orders.length ? err(1, 'failed', [{ ordId: body.ordId, sCode: '51400', sMsg: 'Order cancellation failed' }]) : ok([{ ordId: body.ordId, sCode: '0', sMsg: '' }]);
      }
      case '/api/v5/trade/orders-algo-pending':
        return ok(a.orders.filter((o) => o.algo && (!query.instId || nativeOf('okx', o.base) === query.instId)).map((o) => ({ algoId: String(o.id), instId: nativeOf('okx', o.base), side: o.side.toLowerCase(), posSide: o.posSide.toLowerCase(), ordType: 'conditional', slTriggerPx: o.type === 'STOP' ? fmt(o.trigger) : '', tpTriggerPx: o.type === 'TP' ? fmt(o.trigger) : '', sz: fmt(o.qty / ctv(o.base)) })));
      case '/api/v5/trade/cancel-algos': {
        const ids = new Set((Array.isArray(body) ? body : []).map((x) => String(x.algoId)));
        a.orders = a.orders.filter((o) => !(o.algo && ids.has(String(o.id))));
        return ok([]);
      }
      case '/api/v5/account/positions-history':
        return ok([]);
      default:
        return null;
    }
  }

  // ══════════════════════════ the transport ══════════════════════════
  async function transport({ method, url, headers = {}, body }) {
    const u = new URL(url);
    const host = u.hostname;
    const path = u.pathname;
    const rawQs = u.search ? u.search.slice(1) : '';
    const query = parseQuery(rawQs);
    const rawBody = body === undefined || body === null ? '' : String(body);
    let parsed = {};
    if (rawBody) { try { parsed = JSON.parse(rawBody); } catch (_e) { parsed = {}; } }
    let ex = null;
    if (/(^|\.)bybit\.com$/.test(host)) ex = 'bybit';
    else if (host === 'open-api.bingx.com') ex = 'bingx';
    else if (/binance\.com$/.test(host)) ex = 'binance';
    else if (host === 'www.okx.com') ex = 'okx';
    const key = headers['X-BAPI-API-KEY'] || headers['X-BX-APIKEY'] || headers['X-MBX-APIKEY'] || headers['OK-ACCESS-KEY'] || null;
    let out = null;
    if (ex === 'bybit') out = bybit(method, path, query, parsed, headers, rawQs, rawBody);
    else if (ex === 'bingx') out = bingx(method, path, query, headers, rawQs);
    else if (ex === 'binance') out = binance(method, path, query, headers, rawQs, host);
    else if (ex === 'okx') out = okx(method, path, query, parsed, headers, u.search ? `${path}${u.search}` : path, rawBody);
    const rec = { ex, host, method, path, query, body: rawBody ? parsed : null, key, demo: host === 'api-demo.bybit.com' };
    requests.push(rec);
    if (!out) {
      unhandled.push(rec);
      return { status: 404, headers: { 'content-type': 'text/plain' }, text: 'no route' };
    }
    rec.status = out.status;
    rec.answer = out.text;
    return out;
  }

  return {
    transport, addAccount, account, requests, unhandled, lenient,
    setPrice: (base, p) => { px[base] = p; },
    positions: (ex, key) => allPositions(account(ex, key)),
    orders: (ex, key) => account(ex, key).orders.slice(),
    nativeOf, baseOf,
  };
}

module.exports = { createFakeExchanges };
