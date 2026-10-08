/**
 * Production transport under REAL network failures vs the bot's own HTTP stacks.
 *
 * fixtures/net_errors.json (py/gen_net_errors.py) holds what aiohttp 3.14 and requests 2.x raised
 * — and what the bot's bingx/binance/okx `_request` and a pybit session call returned — for a
 * DNS failure, a refused connect, a server closing / resetting the connection, truncated
 * (Content-Length and chunked) bodies, a silent server and an HTML 502. Here the same failures
 * are produced locally (same bytes on the socket) and sent through transport.fetchTransport
 * (Node fetch) + bybitHttp.requestsError and the JS traders' `_request`; the exception class
 * (pyType), TransportError kind and text must match. Ports differ per run and are substituted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import net from 'net';
import dns from 'dns';
const req = createRequire(import.meta.url);
const { loadFixture, makeClock } = req('./helpers.js');
const { fetchTransport, fetchError, TransportError } = req('../../services/exchanges/transport.js');
const { requestsError, createPybitSession } = req('../../services/exchanges/bybitHttp.js');
const { makeRuntime } = req('../../services/exchanges/runtime.js');
const BX = req('../../services/exchanges/bingxTrader.js');
const BN = req('../../services/exchanges/binanceTrader.js');
const OK = req('../../services/exchanges/okxTrader.js');

const FX = loadFixture('net_errors.json');
const TRUNC_BODY = '{"code":';
const quiet = { debug() {}, info() {}, warning() {}, warn() {}, error() {} };

const servers = [];
const BASES = {};
let dnsMode = null;

function serve(mode) {
  return new Promise((resolve) => {
    const s = net.createServer((c) => {
      c.on('error', () => {});
      c.once('data', () => {
        if (mode === 'close') c.end();
        else if (mode === 'reset') c.resetAndDestroy();
        else if (mode === 'truncated') {
          c.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n${TRUNC_BODY}`);
          setTimeout(() => c.end(), 50);
        } else if (mode === 'chunked') {
          c.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n8\r\n${TRUNC_BODY}\r\n`);
          setTimeout(() => c.end(), 50);
        } else if (mode === 'html') {
          const body = '<html>502 Bad Gateway</html>';
          c.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
        } else if (mode === 'silent') setTimeout(() => c.destroy(), 4000);
      });
    });
    s.listen(0, '127.0.0.1', () => { servers.push(s); resolve(s.address().port); });
  });
}

beforeAll(async () => {
  for (const m of ['close', 'reset', 'truncated', 'chunked', 'silent', 'html']) BASES[m] = `http://127.0.0.1:${await serve(m)}`;
  const tmp = net.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  const closed = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  BASES.refused = `https://127.0.0.1:${closed}`;
  BASES.dns = FX.bases.dns;
  try { await dns.promises.lookup(new URL(FX.bases.dns).hostname); dnsMode = 'resolved'; } catch (e) { dnsMode = e.code; }
});
afterAll(() => { for (const s of servers) s.close(); });

const portOf = (base) => new URL(base).port;
/** expected text with the Python run's port replaced by this run's one */
function localise(value, mode) {
  const pyPort = portOf(FX.bases[mode]);
  const jsPort = portOf(BASES[mode]);
  if (!pyPort || pyPort === jsPort) return value;
  return JSON.parse(JSON.stringify(value).split(pyPort).join(jsPort));
}
const kindOf = (pyType) => (pyType === 'TimeoutError' ? 'timeout' : (/^ClientConnector/.test(pyType) ? 'connect' : 'error'));
const liveOk = (mode) => mode !== 'dns' || dnsMode === 'ENOTFOUND';

describe('fetchTransport failures = aiohttp 3.14 / requests 2.x (client level)', () => {
  for (const row of FX.client) {
    it(`${row.mode} via ${row.client}`, async (ctx) => {
      if (!liveOk(row.mode)) ctx.skip();
      const url = row.url.replace(FX.bases[row.mode], BASES[row.mode]);
      let err = null;
      try {
        await fetchTransport()({ method: 'GET', url, headers: {}, timeoutMs: row.timeout * 1000 });
      } catch (e) { err = e; }
      expect(err).toBeInstanceOf(TransportError);
      const exp = localise(row.got, row.mode);
      if (row.client === 'aiohttp') {
        expect(err.kind, 'kind').toBe(kindOf(exp.type));
        expect({ type: err.pyType, str: err.message }).toEqual(exp);
      } else {
        const pe = requestsError(err, url, row.timeout);
        expect({ type: pe.pyType, str: pe.message }).toEqual(exp);
      }
    }, 10000);
  }
});

function wrapTransport(base) {
  const t = fetchTransport();
  return (r) => t({ ...r, url: r.url.replace(/^https?:\/\/[^/?#]+/, base) });
}

describe('trader _request / pybit session under real failures (trader level)', () => {
  for (const row of FX.trader) {
    it(`${row.exchange} ${row.mode}`, async (ctx) => {
      if (!liveOk(row.mode)) ctx.skip();
      const clock = makeClock(1767225600.0);
      const o = { transport: wrapTransport(BASES[row.mode]), now: clock.now, monotonic: clock.monotonic, sleep: clock.sleep, log: quiet, random: () => 0.5 };
      let got;
      try {
        if (row.exchange === 'bybit') {
          const s = createPybitSession({ apiKey: 'BYKEY123', apiSecret: 'bysecret', rt: makeRuntime(o) });
          got = { result: await s.get_wallet_balance({ accountType: 'UNIFIED', coin: 'USDT' }) };
        } else if (row.exchange === 'bingx') {
          got = { result: await BX.createBingxTrader(o)._request('GET', row.path, 'k', 's') };
        } else if (row.exchange === 'binance') {
          got = { result: await BN.createBinanceTrader(o)._request('GET', row.path, 'k', 's') };
        } else {
          got = { result: await OK.createOkxTrader(o)._request('GET', row.path, 'k', 's', 'pp') };
        }
      } catch (e) {
        got = { raised: { type: e.pyType || e.name, str: e.message } };
      }
      expect(JSON.parse(JSON.stringify(got))).toEqual(localise(row.got, row.mode));
    }, 10000);
  }
});

describe('fetchError mapping (synthetic undici errors, environment independent)', () => {
  const url = 'https://api.bybit.com/v5/account/wallet-balance?accountType=UNIFIED&coin=USDT';
  const undici = (cause) => Object.assign(new TypeError('fetch failed'), { cause });
  it('ENOTFOUND → ClientConnectorDNSError / NameResolutionError, port from the scheme', () => {
    // python: aiohttp + requests against https://<unresolvable host>/… (fixtures/net_errors.json "dns")
    const e = fetchError(undici(Object.assign(new Error('getaddrinfo ENOTFOUND api.bybit.com'), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'api.bybit.com' })), url, 10000);
    expect([e.kind, e.pyType, e.message]).toEqual(['connect', 'ClientConnectorDNSError', 'Cannot connect to host api.bybit.com:443 ssl:default [Name or service not known]']);
    const pe = requestsError(e, url, 10);
    expect([pe.pyType, pe.message]).toEqual(['ConnectionError',
      'HTTPSConnectionPool(host=\'api.bybit.com\', port=443): Max retries exceeded with url: /v5/account/wallet-balance?accountType=UNIFIED&coin=USDT (Caused by NameResolutionError("HTTPSConnection(host=\'api.bybit.com\', port=443): Failed to resolve \'api.bybit.com\' ([Errno -2] Name or service not known)"))']);
  });
  it('EAI_AGAIN → "Temporary failure in name resolution"', () => {
    const e = fetchError(undici(Object.assign(new Error('getaddrinfo EAI_AGAIN open-api.bingx.com'), { code: 'EAI_AGAIN', syscall: 'getaddrinfo' })), 'https://open-api.bingx.com/openApi/x', 15000);
    expect(e.message).toBe('Cannot connect to host open-api.bingx.com:443 ssl:default [Temporary failure in name resolution]');
  });
  it('ECONNRESET is a ClientOSError (kind error): BingX must not run its connect-retry loop on it', () => {
    const e = fetchError(undici(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' })), url, 10000);
    expect([e.kind, e.pyType, e.message]).toEqual(['error', 'ClientOSError', '[Errno 104] Connection reset by peer']);
  });
  it('happy-eyeballs AggregateError uses the first attempt', () => {
    const agg = Object.assign(new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED', syscall: 'connect', address: '1.2.3.4', port: 443 }),
      Object.assign(new Error('connect ECONNREFUSED ::1:443'), { code: 'ECONNREFUSED', syscall: 'connect', address: '::1', port: 443 }),
    ]), {});
    const e = fetchError(undici(agg), 'https://www.okx.com/api/v5/x', 15000);
    expect(e.message).toBe("Cannot connect to host www.okx.com:443 ssl:default [Connect call failed ('1.2.3.4', 443)]");
  });
  it('timeouts: asyncio.TimeoutError text is empty, requests says Read timed out', () => {
    const e = fetchError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), url, 10000);
    expect([e.kind, e.message]).toEqual(['timeout', '']);
    expect(requestsError(e, url, 10).message).toBe("HTTPSConnectionPool(host='api.bybit.com', port=443): Read timed out. (read timeout=10)");
  });
  it('scripted transports (replay fixtures) keep their own text', () => {
    const e = new TransportError('connect', "HTTPSConnectionPool(host='api.bybit.com', port=443): Max retries exceeded (Caused by NameResolutionError)");
    expect(requestsError(e, url, 10).message).toBe(e.message);
  });
});
