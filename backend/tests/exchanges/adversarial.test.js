/**
 * Adversarial parity: 160 seeded random scenarios (30 orders + 10 recorded error replays per
 * exchange) produced by py/gen_adversarial.py from the BOT's own traders.
 *
 * Per scenario the JS trader must reproduce, request for request:
 *   - method / URL / auth headers / body (as harness.py records them),
 *   - every header the trader passed (`hdrs`, lower-cased),
 *   - the result dict (or raised exception), sleeps, [MARKER] log tags, metrics with values and
 *     tags, trade events with payloads, hedge-mode persistence and the final caches;
 * and on the WIRE: each JS request is sent through the production transport (Node fetch,
 * transport.fetchTransport) to a local echo server and must arrive with the same method,
 * request-target, header fields and body as the bot's request did through the real aiohttp /
 * requests client (py/wire.py). Only the origin is redirected to 127.0.0.1.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
const req = createRequire(import.meta.url);
const { runScenario } = req('./replay.js');
const { loadFixture } = req('./helpers.js');
const { EXCHANGES } = req('./callMaps.js');
const { fetchTransport } = req('../../services/exchanges/transport.js');
const fs = req('fs');
const path = req('path');
const { revive } = req('./helpers.js');
const { parseJsonExactInts } = req('../../services/engine/pyjson.js');

// ADV_FIXTURES=<dir> replays an exploratory sweep (gen_adversarial.py --out <dir> --orders N --extreme)
const EXPLORE_DIR = process.env.ADV_FIXTURES || '';
function loadRows(ex) {
  if (!EXPLORE_DIR) return loadFixture(`adversarial_${ex}.json`);
  return revive(parseJsonExactInts(fs.readFileSync(path.join(EXPLORE_DIR, `adversarial_${ex}.json`), 'utf8')));
}

// transport-level fields neither trader sets (py/wire.py TRANSPORT_HEADERS) + undici-only defaults
const DROP = new Set(['host', 'user-agent', 'accept-encoding', 'connection', 'content-length', 'accept-language', 'sec-fetch-mode']);

let server;
let origin;
beforeAll(async () => {
  server = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const headers = {};
      for (const [k, v] of Object.entries(rq.headers)) if (!DROP.has(k)) headers[k] = v;
      const out = JSON.stringify({ method: rq.method, target: rq.url, headers, body: body.length ? body : null });
      rs.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(out), Connection: 'close' });
      rs.end(out);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

/** The production transport, origin swapped for the local echo server. */
function wireSend(r) {
  const t = fetchTransport({ fetchImpl: (url, init) => globalThis.fetch(url.replace(/^https?:\/\/[^/?#]+/, origin), init) });
  return t({ method: r.method, url: r.url, headers: r.hdrs, body: r.body === null ? undefined : r.body, timeoutMs: 10000 })
    .then((resp) => JSON.parse(resp.text));
}

for (const ex of ['bybit', 'bingx', 'binance', 'okx']) {
  const X = EXCHANGES[ex];
  const ROWS = loadRows(ex);

  describe(`${ex} adversarial parity (${ROWS.length} scenarios)`, () => {
    it.skipIf(Boolean(EXPLORE_DIR))('fixture covers 30 random orders + 10 error replays + 16 fuzzed reads + 10 fuzzed flows', () => {
      expect(ROWS.filter((r) => r.scenario.name.startsWith('rnd_')).length).toBe(30);
      expect(ROWS.filter((r) => r.scenario.name.startsWith('err_')).length).toBe(10);
      expect(ROWS.filter((r) => r.scenario.name.startsWith('rd_')).length).toBe(16);
      expect(ROWS.filter((r) => r.scenario.name.startsWith('fz_')).length).toBe(10);
    });

    for (const { scenario: sc, expected: exp } of ROWS) {
      it(sc.name, async () => {
        let res;
        try {
          res = await runScenario(sc, (o) => X.create(o), (t, s) => {
            const fn = X.calls[s.call];
            if (!fn) throw new Error(`no JS mapping for ${s.call}`);
            return fn(t, s.args, s.kwargs);
          }, X.prepare, { allHeaders: true });
        } finally {
          if (X.cleanup) X.cleanup();
        }
        const { out, trader } = res;
        const strip = (rows) => rows.map(({ method, url, headers, body }) => ({ method, url, headers, body }));
        expect(strip(out.requests), 'requests').toEqual(strip(exp.requests));
        expect(out.requests.map((r) => r.hdrs), 'all passed headers').toEqual(exp.requests.map((r) => r.hdrs));
        if (exp.raised) expect(out.raised, 'raised').toEqual(exp.raised);
        else expect(out.result, 'result').toEqual(exp.result);
        expect(out.sleeps, 'sleeps').toEqual(exp.sleeps);
        expect(out.markers, 'log markers').toEqual(exp.markers);
        expect(out.saved, 'saved').toEqual(exp.saved);
        expect(out.full_metrics, 'metrics with values + tags').toEqual(exp.full_metrics);
        expect(out.full_events, 'trade events with payloads').toEqual(exp.full_events);
        expect(X.final(trader), 'final caches').toEqual(X.expectedFinal(exp.final));

        // wire: production transport vs the bot's real client library
        for (let i = 0; i < out.requests.length; i++) {
          const got = await wireSend(out.requests[i]);
          expect(got, `wire #${i} ${out.requests[i].method} ${out.requests[i].url}`).toEqual(exp.requests[i].wire);
        }
      });
    }
  });
}
